import test from "node:test";
import assert from "node:assert/strict";

import {
  getSharedAppDataHash,
  resolveInitialSharedAppData,
  shouldPersistSharedAppData,
} from "./sharedAppDataSync.js";

const defaultWeeks = ["Week 1", "Week 2"];

function makeData(overrides = {}) {
  return {
    models: [],
    schedule: [],
    liveJobs: [],
    rawStockInventory: [],
    reusableDropInventory: [],
    scheduleWeeks: defaultWeeks,
    ...overrides,
  };
}

test("a failed cloud read never hydrates or permits local migration", () => {
  const localData = makeData({
    schedule: [{ id: "stale-local-job" }],
    liveJobs: [{ id: "stale-local-live-job" }],
  });
  const result = resolveInitialSharedAppData({
    cloudRecord: null,
    cloudError: new Error("network unavailable"),
    localData,
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(result.status, "load-error");
  assert.equal(result.data, null);
  assert.equal(result.shouldMigrateLocal, false);
  assert.equal(result.canEnableWrites, false);
});

test("a valid cloud row wins over empty or stale device storage", () => {
  const cloudData = makeData({
    schedule: [{ id: "schedule-1" }, { id: "schedule-2" }, { id: "schedule-3" }],
    liveJobs: [{ id: "live-1", stageCompleteQty: 0 }],
  });
  const result = resolveInitialSharedAppData({
    cloudRecord: { data: cloudData },
    cloudError: null,
    localData: makeData({ schedule: [{ id: "stale-local-job" }] }),
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(result.status, "loaded-cloud");
  assert.deepEqual(result.data.schedule, cloudData.schedule);
  assert.deepEqual(result.data.liveJobs, cloudData.liveJobs);
  assert.equal(result.shouldMigrateLocal, false);
  assert.equal(result.canEnableWrites, true);
});

test("an invalid cloud payload is not interpreted as empty production data", () => {
  const result = resolveInitialSharedAppData({
    cloudRecord: { data: { models: [] } },
    cloudError: null,
    localData: makeData(),
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(result.status, "invalid-cloud-data");
  assert.equal(result.data, null);
  assert.equal(result.canEnableWrites, false);
});

test("a missing or RLS-hidden cloud row never triggers localStorage migration", () => {
  const localData = makeData({ schedule: [{ id: "first-install-job" }] });
  const result = resolveInitialSharedAppData({
    cloudRecord: null,
    cloudError: null,
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(result.status, "missing-cloud-record");
  assert.equal(result.shouldMigrateLocal, false);
  assert.equal(result.canEnableWrites, false);
  assert.equal(result.data, null);
  assert.equal(localData.schedule.length, 1);
});

test("an empty successful query is distinct from an error but still remains read-only", () => {
  const result = resolveInitialSharedAppData({
    cloudRecord: null,
    cloudError: null,
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(result.status, "missing-cloud-record");
  assert.equal(result.shouldMigrateLocal, false);
  assert.equal(result.canEnableWrites, false);
});

test("autosave remains disabled until hydration and ignores an unchanged cloud baseline", () => {
  const data = makeData({ schedule: [{ id: "schedule-1" }] });
  const lastSyncedHash = getSharedAppDataHash(data, defaultWeeks);

  assert.equal(
    shouldPersistSharedAppData({
      isAuthenticated: true,
      isHydrated: false,
      isCloudReady: false,
      currentData: data,
      lastSyncedHash,
      defaultScheduleWeeks: defaultWeeks,
    }),
    false
  );

  assert.equal(
    shouldPersistSharedAppData({
      isAuthenticated: true,
      isHydrated: true,
      isCloudReady: true,
      currentData: data,
      lastSyncedHash,
      defaultScheduleWeeks: defaultWeeks,
    }),
    false
  );

  assert.equal(
    shouldPersistSharedAppData({
      isAuthenticated: true,
      isHydrated: true,
      isCloudReady: true,
      currentData: makeData({ schedule: [{ id: "schedule-1" }, { id: "schedule-2" }] }),
      lastSyncedHash,
      defaultScheduleWeeks: defaultWeeks,
    }),
    true
  );
});

test("cross-device hydration and a +1 Live update preserve all Schedule data", () => {
  let sharedCloudData = makeData({
    schedule: [{ id: "schedule-1" }, { id: "schedule-2" }, { id: "schedule-3" }],
    liveJobs: [{ id: "live-1", stageCompleteQty: 0 }],
  });
  let databaseWrites = 0;
  const deviceBStartup = resolveInitialSharedAppData({
    cloudRecord: { data: sharedCloudData },
    cloudError: null,
    localData: makeData(),
    defaultScheduleWeeks: defaultWeeks,
  });
  const deviceBBaseline = getSharedAppDataHash(deviceBStartup.data, defaultWeeks);

  assert.equal(deviceBStartup.data.schedule.length, 3);
  assert.equal(deviceBStartup.data.liveJobs.length, 1);
  assert.equal(databaseWrites, 0);

  const deviceBUpdate = {
    ...deviceBStartup.data,
    liveJobs: deviceBStartup.data.liveJobs.map((job) => ({
      ...job,
      stageCompleteQty: job.stageCompleteQty + 1,
    })),
  };

  const shouldSaveDeviceBUpdate = shouldPersistSharedAppData({
    isAuthenticated: true,
    isHydrated: true,
    isCloudReady: true,
    currentData: deviceBUpdate,
    lastSyncedHash: deviceBBaseline,
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(shouldSaveDeviceBUpdate, true);
  if (shouldSaveDeviceBUpdate) {
    sharedCloudData = deviceBUpdate;
    databaseWrites += 1;
  }

  const deviceAReload = resolveInitialSharedAppData({
    cloudRecord: { data: sharedCloudData },
    cloudError: null,
    localData: makeData(),
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(deviceAReload.data.schedule.length, 3);
  assert.equal(deviceAReload.data.liveJobs[0].stageCompleteQty, 1);

  const deviceBReopen = resolveInitialSharedAppData({
    cloudRecord: { data: sharedCloudData },
    cloudError: null,
    localData: makeData(),
    defaultScheduleWeeks: defaultWeeks,
  });
  const shouldSaveOnReopen = shouldPersistSharedAppData({
    isAuthenticated: true,
    isHydrated: true,
    isCloudReady: true,
    currentData: deviceBReopen.data,
    lastSyncedHash: getSharedAppDataHash(sharedCloudData, defaultWeeks),
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(deviceBReopen.data.schedule.length, 3);
  assert.equal(deviceBReopen.data.liveJobs[0].stageCompleteQty, 1);
  assert.equal(shouldSaveOnReopen, false);
  assert.equal(databaseWrites, 1);
});

test("logout disables persistence and login or hard refresh rehydrates from Supabase", () => {
  const cloudData = makeData({
    schedule: [{ id: "schedule-1" }, { id: "schedule-2" }, { id: "schedule-3" }],
    liveJobs: [{ id: "live-1", stageCompleteQty: 1 }],
  });
  const cloudHash = getSharedAppDataHash(cloudData, defaultWeeks);

  assert.equal(
    shouldPersistSharedAppData({
      isAuthenticated: false,
      isHydrated: true,
      isCloudReady: true,
      currentData: cloudData,
      lastSyncedHash: cloudHash,
      defaultScheduleWeeks: defaultWeeks,
    }),
    false
  );

  for (const localData of [makeData(), makeData({ schedule: [{ id: "stale" }] })]) {
    const refreshed = resolveInitialSharedAppData({
      cloudRecord: { data: cloudData },
      cloudError: null,
      localData,
      defaultScheduleWeeks: defaultWeeks,
    });

    assert.equal(refreshed.status, "loaded-cloud");
    assert.equal(refreshed.data.schedule.length, 3);
    assert.equal(refreshed.data.liveJobs[0].stageCompleteQty, 1);
  }
});

test("a temporary load failure stays read-only and a later successful reload recovers", () => {
  const cloudData = makeData({
    schedule: [{ id: "schedule-1" }, { id: "schedule-2" }, { id: "schedule-3" }],
    liveJobs: [{ id: "live-1", stageCompleteQty: 1 }],
  });
  const failedAttempt = resolveInitialSharedAppData({
    cloudRecord: null,
    cloudError: new Error("offline"),
    localData: makeData(),
    defaultScheduleWeeks: defaultWeeks,
  });
  const recoveredAttempt = resolveInitialSharedAppData({
    cloudRecord: { data: cloudData },
    cloudError: null,
    localData: makeData(),
    defaultScheduleWeeks: defaultWeeks,
  });

  assert.equal(failedAttempt.canEnableWrites, false);
  assert.equal(failedAttempt.data, null);
  assert.equal(recoveredAttempt.canEnableWrites, true);
  assert.equal(recoveredAttempt.data.schedule.length, 3);
  assert.equal(recoveredAttempt.data.liveJobs.length, 1);
});
