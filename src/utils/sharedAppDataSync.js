const REQUIRED_CLOUD_FIELDS = ["models", "schedule", "liveJobs", "scheduleWeeks"];

export function normalizeSharedAppData(data, defaultScheduleWeeks = []) {
  const source = data && typeof data === "object" ? data : {};

  return {
    models: Array.isArray(source.models) ? source.models : [],
    schedule: Array.isArray(source.schedule) ? source.schedule : [],
    liveJobs: Array.isArray(source.liveJobs) ? source.liveJobs : [],
    rawStockInventory: Array.isArray(source.rawStockInventory)
      ? source.rawStockInventory
      : [],
    reusableDropInventory: Array.isArray(source.reusableDropInventory)
      ? source.reusableDropInventory
      : [],
    scheduleWeeks: Array.isArray(source.scheduleWeeks)
      ? source.scheduleWeeks
      : defaultScheduleWeeks,
  };
}

export function isValidCloudAppData(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      REQUIRED_CLOUD_FIELDS.every((field) => Array.isArray(data[field]))
  );
}

export function getSharedAppDataHash(data, defaultScheduleWeeks = []) {
  return JSON.stringify(normalizeSharedAppData(data, defaultScheduleWeeks));
}

export function resolveInitialSharedAppData({
  cloudRecord,
  cloudError,
  defaultScheduleWeeks = [],
}) {
  if (cloudError) {
    return {
      status: "load-error",
      data: null,
      shouldMigrateLocal: false,
      canEnableWrites: false,
    };
  }

  if (cloudRecord) {
    if (!isValidCloudAppData(cloudRecord.data)) {
      return {
        status: "invalid-cloud-data",
        data: null,
        shouldMigrateLocal: false,
        canEnableWrites: false,
      };
    }

    return {
      status: "loaded-cloud",
      data: normalizeSharedAppData(cloudRecord.data, defaultScheduleWeeks),
      shouldMigrateLocal: false,
      canEnableWrites: true,
    };
  }

  return {
    status: "missing-cloud-record",
    data: null,
    shouldMigrateLocal: false,
    canEnableWrites: false,
  };
}

export function shouldPersistSharedAppData({
  isAuthenticated,
  isHydrated,
  isCloudReady,
  currentData,
  lastSyncedHash,
  defaultScheduleWeeks = [],
}) {
  if (!isAuthenticated || !isHydrated || !isCloudReady) return false;

  return (
    getSharedAppDataHash(currentData, defaultScheduleWeeks) !== lastSyncedHash
  );
}
