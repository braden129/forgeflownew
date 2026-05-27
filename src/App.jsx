import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { supabase } from "./supabaseClient";

const STAGES = [
  "Fabrication",
  "Welding",
  "Assembly",
  "Paint Line",
  "Shipping",
  "Orders Sent",
];

const DEFAULT_SCHEDULE_WEEKS = [
  "Week of",
  "Week of",
  "Week of",
  "Week of",
  "Week of",
];

const VIEWS = ["Models", "Schedule", "Live", "Messages", ...STAGES];
const PRIMARY_VIEWS = ["Models", "Schedule", "Live", "Messages"];
const MESSAGE_RECIPIENTS = [
  "Everyone",
  "Fabrication",
  "Welding",
  "Assembly",
  "Paint Line",
  "Shipping",
  "Supervisor",
  "Dev-Braden",
];

const AUTO_ARCHIVE_COMPLETED_AFTER_DAYS = 7;

const ROLES = ["Employee", "Supervisor", "Admin", "Developer"];
const EMPLOYEE_DEPARTMENTS = [
  "Fabrication",
  "Welding",
  "Assembly",
  "Paint Line",
  "Shipping",
];

const APP_DATA_ID = "admiral-production-data";
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const REALTIME_CHANNEL_NAME = "app-data-live-updates";
const SHOP_MESSAGES_CHANNEL_NAME = "shop-messages-live-updates";

const FISHBOWL_HEADER_ALIASES = {
  collection: ["collection", "collection name", "model", "model name", "category", "product line"],
  furniture: ["furniture", "furniture name", "item", "item name", "product", "product name", "description", "part description"],
  sku: ["sku", "item number", "item no", "item #", "part number", "part no", "number", "product code"],
  qty: ["qty", "quantity", "qty needed", "quantity needed", "order qty", "scheduled qty", "to build"],
  dueDate: ["due date", "date", "ship date", "scheduled date", "schedule date", "week", "week of"],
  notes: ["notes", "note", "memo", "customer", "customer name", "sales order", "so", "order", "order number", "work order", "wo"],
};

function normalizeCsvHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      field += '"';
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field.trim());
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") i += 1;
      row.push(field.trim());
      field = "";

      if (row.some((cell) => String(cell || "").trim())) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    field += char;
  }

  row.push(field.trim());

  if (row.some((cell) => String(cell || "").trim())) {
    rows.push(row);
  }

  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeCsvHeader);

  return rows.slice(1).map((cells) => {
    const item = {};

    headers.forEach((header, index) => {
      item[header] = cells[index] || "";
    });

    return item;
  });
}

function findCsvValue(row, fieldName) {
  const aliases = FISHBOWL_HEADER_ALIASES[fieldName] || [];
  const normalizedAliases = aliases.map(normalizeCsvHeader);
  const foundKey = Object.keys(row).find((key) => normalizedAliases.includes(key));
  return foundKey ? row[foundKey] : "";
}

function parseQuantity(value) {
  const qty = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(qty) && qty > 0 ? Math.round(qty) : 1;
}


const LOGIN_USERS = [
  {
    username: "braden",
    email: "braden@forgeflow.local",
    displayName: "Braden",
  },
  {
    username: "tech",
    email: "tech@forgeflow.local",
    displayName: "Tech",
  },
  {
    username: "admin",
    email: "admin@forgeflow.local",
    displayName: "Admin",
  },
  {
    username: "supervisor",
    email: "supervisor@forgeflow.local",
    displayName: "Supervisor",
  },
  {
    username: "employee",
    email: "employee@forgeflow.local",
    displayName: "Employee",
  },
];

function mapSupabaseRole(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();

  if (normalizedRole === "dev" || normalizedRole === "developer") return "Developer";
  if (normalizedRole === "admin") return "Admin";
  if (normalizedRole === "supervisor") return "Supervisor";
  if (normalizedRole === "employee") return "Employee";

  return "Employee";
}

function normalizeDepartment(department) {
  const match = EMPLOYEE_DEPARTMENTS.find(
    (item) => item.toLowerCase() === String(department || "").trim().toLowerCase()
  );

  return match || "Fabrication";
}

function getSavedArray(key, fallback = []) {
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    return Array.isArray(saved) ? saved : fallback;
  } catch (error) {
    return fallback;
  }
}

function getStoredUser() {
  try {
    const saved = JSON.parse(localStorage.getItem("loggedInUser"));
    if (!saved || !ROLES.includes(saved.role)) return null;

    return {
      username: saved.username || "",
      displayName: saved.displayName || saved.username || saved.role,
      role: saved.role,
    };
  } catch (error) {
    return null;
  }
}

const emptyPartForm = {
  name: "",
  tube: "",
  length: "",
  qty: "",
  angle: "",
  notes: "",
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getLegacyWeekSlot(week) {
  const legacyWeeks = ["Week 1", "Week 2", "Week 3", "Week 4", "Week 5"];
  const index = legacyWeeks.indexOf(week);
  return index === -1 ? 0 : index;
}

function cleanScheduleDateLabel(value) {
  const label = String(value || "").trim();
  if (!label) return "N/A";
  return label.replace(/^week\s+of\s*/i, "").trim() || "N/A";
}

function getScheduleDateLabel(scheduleWeeks, job) {
  if (job?.dueDate) return cleanScheduleDateLabel(job.dueDate);

  if (typeof job?.weekSlot === "number") {
    return cleanScheduleDateLabel(scheduleWeeks[job.weekSlot]) || `Week ${job.weekSlot + 1}`;
  }

  if (job?.week) return cleanScheduleDateLabel(job.week);

  return "N/A";
}

function stageSlug(stage) {
  return String(stage || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function App() {
  const [view, setView] = useState("Models");
  const [search, setSearch] = useState("");

  const [models, setModels] = useState(() => {
    return JSON.parse(localStorage.getItem("models")) || [];
  });

  const [schedule, setSchedule] = useState(() => {
    return JSON.parse(localStorage.getItem("schedule")) || [];
  });

  const [liveJobs, setLiveJobs] = useState(() => {
    return JSON.parse(localStorage.getItem("liveJobs")) || [];
  });

  const [scheduleWeeks, setScheduleWeeks] = useState(() => {
    return (
      JSON.parse(localStorage.getItem("scheduleWeeks")) ||
      DEFAULT_SCHEDULE_WEEKS
    );
  });

  const [selectedModelId, setSelectedModelId] = useState(null);
  const [openTypeId, setOpenTypeId] = useState(null);

  const [modelName, setModelName] = useState("");
  const [typeName, setTypeName] = useState("");
  const [typeImage, setTypeImage] = useState(null);

  const [editingTypeId, setEditingTypeId] = useState(null);
  const [editingTypeName, setEditingTypeName] = useState("");
  const [editingTypeImage, setEditingTypeImage] = useState(null);

  const [partForm, setPartForm] = useState(emptyPartForm);
  const [editingPartId, setEditingPartId] = useState(null);

  const [scheduleForm, setScheduleForm] = useState({
    qty: 1,
    weekSlot: 0,
    dueDate: "",
    notes: "",
  });

  const backupInputRef = useRef(null);
  const fishbowlCsvInputRef = useRef(null);
  const messagePhotoInputRef = useRef(null);
  const cloudReadyRef = useRef(false);
  const cloudSaveTimerRef = useRef(null);
  const lastSnapshotAtRef = useRef(0);
  const lastSnapshotHashRef = useRef("");
  const realtimeClientIdRef = useRef(makeId());
  const skipNextCloudSaveRef = useRef(false);
  const [currentUser, setCurrentUser] = useState(getStoredUser);
  const [authLoading, setAuthLoading] = useState(true);
  const [cloudDataLoaded, setCloudDataLoaded] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState("");
  const [fishbowlImportSummary, setFishbowlImportSummary] = useState("");
  const [shopMessages, setShopMessages] = useState([]);
  const [shopMessageText, setShopMessageText] = useState("");
  const [shopMessageTo, setShopMessageTo] = useState("Everyone");
  const [shopMessagePhoto, setShopMessagePhoto] = useState(null);
  const [shopMessagePhotoName, setShopMessagePhotoName] = useState("");
  const currentRole = currentUser?.role || "Employee";

  const [employeeDepartment, setEmployeeDepartment] = useState(() => {
    const savedDepartment = localStorage.getItem("employeeDepartment");
    const savedRole = localStorage.getItem("currentRole");

    if (EMPLOYEE_DEPARTMENTS.includes(savedDepartment)) return savedDepartment;
    if (EMPLOYEE_DEPARTMENTS.includes(savedRole)) return savedRole;

    return "Fabrication";
  });

  const [cutSheetView, setCutSheetView] = useState(null);
  const [selectedScheduleWeek, setSelectedScheduleWeek] = useState(0);
  const [employeePanelTab, setEmployeePanelTab] = useState(employeeDepartment);
  const [liveOverviewTab, setLiveOverviewTab] = useState("Fabrication");

  const writeLocalAppData = (nextData) => {
    localStorage.setItem("models", JSON.stringify(nextData.models || []));
    localStorage.setItem("schedule", JSON.stringify(nextData.schedule || []));
    localStorage.setItem("liveJobs", JSON.stringify(nextData.liveJobs || []));
    localStorage.setItem(
      "scheduleWeeks",
      JSON.stringify(nextData.scheduleWeeks || DEFAULT_SCHEDULE_WEEKS)
    );
  };

  const applyAppData = (nextData) => {
    const nextModels = Array.isArray(nextData?.models) ? nextData.models : [];
    const nextSchedule = Array.isArray(nextData?.schedule) ? nextData.schedule : [];
    const nextLiveJobs = Array.isArray(nextData?.liveJobs) ? nextData.liveJobs : [];
    const nextScheduleWeeks = Array.isArray(nextData?.scheduleWeeks)
      ? nextData.scheduleWeeks
      : DEFAULT_SCHEDULE_WEEKS;

    setModels(nextModels);
    setSchedule(nextSchedule);
    setLiveJobs(nextLiveJobs);
    setScheduleWeeks(nextScheduleWeeks);
    writeLocalAppData({
      models: nextModels,
      schedule: nextSchedule,
      liveJobs: nextLiveJobs,
      scheduleWeeks: nextScheduleWeeks,
    });
  };

  const createAppDataSnapshot = async (payload, reason = "auto-save") => {
    if (!currentUser) return;

    const snapshotHash = JSON.stringify(payload);
    const now = Date.now();
    const shouldSkipSnapshot =
      reason === "auto-save" &&
      (snapshotHash === lastSnapshotHashRef.current ||
        now - lastSnapshotAtRef.current < SNAPSHOT_INTERVAL_MS);

    if (shouldSkipSnapshot) return;

    const snapshotRecord = {
      appDataId: APP_DATA_ID,
      reason,
      savedAt: payload.savedAt,
      savedBy: {
        id: currentUser.id || null,
        email: currentUser.email || null,
        username: currentUser.username || null,
        displayName: currentUser.displayName || null,
        role: currentUser.role || null,
      },
      counts: {
        models: payload.models.length,
        schedule: payload.schedule.length,
        liveJobs: payload.liveJobs.length,
        scheduleWeeks: payload.scheduleWeeks.length,
      },
      data: payload,
    };

    const { error } = await supabase
      .from("app_data_snapshots")
      .insert({ data: snapshotRecord });

    if (error) {
      console.warn("Snapshot save failed, but main cloud save is still safe:", error);
      return;
    }

    lastSnapshotAtRef.current = now;
    lastSnapshotHashRef.current = snapshotHash;
  };

  const saveSharedAppData = async (nextData, options = {}) => {
    if (!currentUser) return false;

    const payload = {
      models: Array.isArray(nextData.models) ? nextData.models : [],
      schedule: Array.isArray(nextData.schedule) ? nextData.schedule : [],
      liveJobs: Array.isArray(nextData.liveJobs) ? nextData.liveJobs : [],
      scheduleWeeks: Array.isArray(nextData.scheduleWeeks)
        ? nextData.scheduleWeeks
        : DEFAULT_SCHEDULE_WEEKS,
      savedAt: new Date().toISOString(),
      savedByClientId: realtimeClientIdRef.current,
      savedByUser: currentUser
        ? {
            id: currentUser.id || null,
            email: currentUser.email || null,
            username: currentUser.username || null,
            displayName: currentUser.displayName || null,
            role: currentUser.role || null,
          }
        : null,
    };

    const { error } = await supabase.from("app_data").upsert(
      {
        id: APP_DATA_ID,
        updated_at: new Date().toISOString(),
        data: payload,
      },
      { onConflict: "id" }
    );

    if (error) {
      console.error("Cloud save failed:", error);
      return false;
    }

    await createAppDataSnapshot(payload, options.snapshotReason || "auto-save");

    return true;
  };

  const loadSharedAppData = async () => {
    setCloudDataLoaded(false);

    const { data, error } = await supabase
      .from("app_data")
      .select("data")
      .eq("id", APP_DATA_ID)
      .maybeSingle();

    if (error) {
      console.error("Cloud load failed:", error);
      cloudReadyRef.current = true;
      setCloudDataLoaded(true);
      return;
    }

    if (data?.data) {
      applyAppData(data.data);
    } else {
      const localPayload = {
        models: getSavedArray("models"),
        schedule: getSavedArray("schedule"),
        liveJobs: getSavedArray("liveJobs"),
        scheduleWeeks: getSavedArray("scheduleWeeks", DEFAULT_SCHEDULE_WEEKS),
      };

      if (
        localPayload.models.length > 0 ||
        localPayload.schedule.length > 0 ||
        localPayload.liveJobs.length > 0
      ) {
        await saveSharedAppData(localPayload);
      }
    }

    cloudReadyRef.current = true;
    setCloudDataLoaded(true);
  };

  const loadSupabaseUser = async (user) => {
    if (!user) {
      cloudReadyRef.current = false;
      setCloudDataLoaded(false);
      setCurrentUser(null);
      localStorage.removeItem("loggedInUser");
      localStorage.removeItem("currentRole");
      return;
    }

    const loginUser = LOGIN_USERS.find(
      (item) => item.email.toLowerCase() === String(user.email || "").toLowerCase()
    );

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("email, role, department")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      console.error("Could not load user profile:", error);
    }

    const appRole = mapSupabaseRole(profile?.role || loginUser?.username);
    const safeUser = {
      id: user.id,
      email: user.email,
      username: loginUser?.username || user.email,
      displayName: loginUser?.displayName || profile?.email || user.email || appRole,
      role: appRole,
    };

    setCurrentUser(safeUser);
    localStorage.setItem("loggedInUser", JSON.stringify(safeUser));
    localStorage.setItem("currentRole", appRole);

    if (appRole === "Employee") {
      const nextDepartment = normalizeDepartment(profile?.department || employeeDepartment);
      setEmployeeDepartment(nextDepartment);
      setEmployeePanelTab(nextDepartment);
      setView(nextDepartment);
    } else {
      setView("Live");
    }

    await loadSharedAppData();
  };

  useEffect(() => {
    let isMounted = true;

    const loadInitialSession = async () => {
      setAuthLoading(true);

      const { data, error } = await supabase.auth.getSession();

      if (error) {
        console.error("Could not load Supabase session:", error);
      }

      if (isMounted) {
        await loadSupabaseUser(data?.session?.user || null);
        setAuthLoading(false);
      }
    };

    loadInitialSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (!isMounted) return;
      await loadSupabaseUser(session?.user || null);
      setAuthLoading(false);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!currentUser || !cloudDataLoaded) return;

    const channel = supabase
      .channel(REALTIME_CHANNEL_NAME)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "app_data",
          filter: `id=eq.${APP_DATA_ID}`,
        },
        (change) => {
          const remoteData = change?.new?.data;

          if (!remoteData) return;
          if (remoteData.savedByClientId === realtimeClientIdRef.current) return;

          skipNextCloudSaveRef.current = true;
          applyAppData(remoteData);
          console.info("Live update received from Supabase.");
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.info("Supabase live updates connected.");
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUser, cloudDataLoaded]);

  useEffect(() => {
    if (!currentUser || !cloudDataLoaded) return;

    loadShopMessages();

    const channel = supabase
      .channel(SHOP_MESSAGES_CHANNEL_NAME)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "shop_messages",
        },
        (change) => {
          const newMessage = change?.new;
          if (!newMessage) return;

          setShopMessages((currentMessages) => {
            if (currentMessages.some((message) => message.id === newMessage.id)) {
              return currentMessages;
            }

            return [newMessage, ...currentMessages].slice(0, 100);
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "shop_messages",
        },
        (change) => {
          const updatedMessage = change?.new;
          if (!updatedMessage) return;

          setShopMessages((currentMessages) =>
            currentMessages.map((message) =>
              message.id === updatedMessage.id ? updatedMessage : message
            )
          );
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "shop_messages",
        },
        (change) => {
          const deletedId = change?.old?.id;
          if (!deletedId) return;

          setShopMessages((currentMessages) =>
            currentMessages.filter((message) => message.id !== deletedId)
          );
        }
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.info("Shop messages live updates connected.");
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUser, cloudDataLoaded]);

  useEffect(() => {
    if (!currentUser || !cloudReadyRef.current || !cloudDataLoaded) return;

    if (skipNextCloudSaveRef.current) {
      skipNextCloudSaveRef.current = false;
      return;
    }

    if (cloudSaveTimerRef.current) {
      clearTimeout(cloudSaveTimerRef.current);
    }

    cloudSaveTimerRef.current = setTimeout(() => {
      saveSharedAppData({
        models,
        schedule,
        liveJobs,
        scheduleWeeks,
      });
    }, 900);

    return () => {
      if (cloudSaveTimerRef.current) {
        clearTimeout(cloudSaveTimerRef.current);
      }
    };
  }, [models, schedule, liveJobs, scheduleWeeks, currentUser, cloudDataLoaded]);

  useEffect(() => {
    if (!currentUser || !cloudDataLoaded || schedule.length === 0) return;

    const cutoff = Date.now() - AUTO_ARCHIVE_COMPLETED_AFTER_DAYS * 24 * 60 * 60 * 1000;
    let changed = false;

    const nextSchedule = schedule
      .map((job) => {
        if (job.status !== "Complete") return job;
        if (job.completedAt) return job;

        changed = true;
        return {
          ...job,
          completedAt: new Date().toISOString(),
        };
      })
      .filter((job) => {
        if (job.status !== "Complete" || !job.completedAt) return true;
        const completedTime = new Date(job.completedAt).getTime();
        if (!Number.isFinite(completedTime)) return true;

        const shouldArchive = completedTime < cutoff;
        if (shouldArchive) changed = true;
        return !shouldArchive;
      });

    if (changed) {
      setSchedule(nextSchedule);
    }
  }, [schedule, currentUser, cloudDataLoaded]);

  useEffect(() => {
    localStorage.setItem("models", JSON.stringify(models));
  }, [models]);

  useEffect(() => {
    localStorage.setItem("schedule", JSON.stringify(schedule));
  }, [schedule]);

  useEffect(() => {
    localStorage.setItem("liveJobs", JSON.stringify(liveJobs));
  }, [liveJobs]);

  useEffect(() => {
    localStorage.setItem("scheduleWeeks", JSON.stringify(scheduleWeeks));
  }, [scheduleWeeks]);

  useEffect(() => {
    localStorage.setItem("employeeDepartment", employeeDepartment);
  }, [employeeDepartment]);

  useEffect(() => {
    setEmployeePanelTab(employeeDepartment);
  }, [employeeDepartment]);

  const selectedModel = models.find((m) => m.id === selectedModelId);
  const elevatedModes = ["Developer", "Admin", "Supervisor"];
  const canManage = elevatedModes.includes(currentRole);
  const canDelete = currentRole === "Developer";
  const canRemoveLiveJob = ["Developer", "Supervisor"].includes(currentRole);
  const canOperateJobs = currentRole !== "Admin";
  const canPrint = ["Developer", "Admin"].includes(currentRole);
  const canSeeFullLive = elevatedModes.includes(currentRole);
  const isEmployeeMode = currentRole === "Employee";
  const isAdminLiveOverview = ["Admin", "Supervisor"].includes(currentRole) && view === "Live";

  const matches = (text) =>
    String(text || "").toLowerCase().includes(search.toLowerCase());

  const hasSearch = search.trim().length > 0;

  const furnitureMatchesSearch = (model, type) => {
    const specs = type.specs || {};

    return (
      matches(model.name) ||
      matches(type.name) ||
      matches(type.sku) ||
      matches(specs.sku) ||
      matches(type.dimensions) ||
      matches(specs.dimensions) ||
      matches(type.material) ||
      matches(specs.material)
    );
  };

  const getItemSpecs = (item) => {
    const specs = item.specs || {};

    return {
      sku: item.sku || specs.sku || "",
      dimensions: item.dimensions || specs.dimensions || "",
      seatHeight: item.seatHeight || specs.seatHeight || "",
      seatWidth: item.seatWidth || specs.seatWidth || "",
      seatDepth: item.seatDepth || specs.seatDepth || "",
      stackable: item.stackable || specs.stackable || "",
      material: item.material || specs.material || "",
    };
  };

  const getJobWeekSlot = (job) => {
    if (typeof job.weekSlot === "number") return job.weekSlot;
    return getLegacyWeekSlot(job.week);
  };

  const filteredModels = models.filter((model) => {
    if (!hasSearch) return true;

    return (
      matches(model.name) ||
      model.types?.some((type) => furnitureMatchesSearch(model, type))
    );
  });

  const selectedModelTypes = selectedModel?.types?.filter((type) => {
    if (!hasSearch) return true;
    return furnitureMatchesSearch(selectedModel, type);
  }) || [];

  const filteredSchedule = schedule.filter((job) => {
    const weekName = scheduleWeeks[getJobWeekSlot(job)] || "";

    return (
      matches(job.collection) ||
      matches(job.furniture) ||
      matches(job.sku) ||
      matches(job.specs?.sku) ||
      matches(job.dimensions) ||
      matches(job.specs?.dimensions) ||
      matches(job.material) ||
      matches(job.specs?.material) ||
      matches(job.status) ||
      matches(weekName) ||
      matches(job.week)
    );
  });

  const filteredLiveJobs = liveJobs.filter(
    (job) =>
      matches(job.collection) ||
      matches(job.furniture) ||
      matches(job.sku) ||
      matches(job.specs?.sku) ||
      matches(job.dimensions) ||
      matches(job.specs?.dimensions) ||
      matches(job.material) ||
      matches(job.specs?.material) ||
      matches(STAGES[job.stage])
  );

  const dashboard = useMemo(() => {
    const scheduledQty = schedule.reduce(
      (sum, job) => sum + Number(job.qtyNeeded || 0),
      0
    );

    const completedQty = schedule.reduce(
      (sum, job) => sum + Number(job.qtyComplete || 0),
      0
    );

    return {
      scheduledJobs: schedule.length,
      scheduledQty,
      completedQty,
      activeJobs: liveJobs.length,
    };
  }, [schedule, liveJobs]);

  const readImage = (file, callback) => {
    if (!file) return;

    const reader = new FileReader();

    reader.onloadend = () => {
      callback(reader.result);
    };

    reader.readAsDataURL(file);
  };

  const confirmPermanentDelete = (label) => {
    return window.confirm(`Are you sure you want to permanently delete ${label}?`);
  };

  const updateScheduleWeekName = (index, value) => {
    setScheduleWeeks(
      scheduleWeeks.map((week, weekIndex) =>
        weekIndex === index ? value : week
      )
    );
  };

  const addModel = () => {
    if (!modelName.trim()) return;

    setModels([
      {
        id: makeId(),
        name: modelName.trim(),
        types: [],
      },
      ...models,
    ]);

    setModelName("");
  };

  const deleteModel = (modelId) => {
    const model = models.find((m) => m.id === modelId);
    if (!confirmPermanentDelete(`the collection "${model?.name || "this collection"}" and all furniture inside it`)) return;

    setModels(models.filter((m) => m.id !== modelId));

    if (selectedModelId === modelId) {
      setSelectedModelId(null);
      setOpenTypeId(null);
    }
  };

  const addType = () => {
    if (!selectedModel || !typeName.trim()) return;

    setModels(
      models.map((model) =>
        model.id === selectedModelId
          ? {
              ...model,
              types: [
                ...model.types,
                {
                  id: makeId(),
                  name: typeName.trim(),
                  image: typeImage,
                  parts: [],
                },
              ],
            }
          : model
      )
    );

    setTypeName("");
    setTypeImage(null);
  };

  const cloneFurniture = (type) => {
    if (!selectedModel) return;

    const clonedParts = (type.parts || []).map((part) => ({
      ...part,
      id: makeId(),
    }));

    const clonedType = {
      ...type,
      id: makeId(),
      name: `${type.name} Copy`,
      parts: clonedParts,
    };

    setModels(
      models.map((model) =>
        model.id === selectedModelId
          ? {
              ...model,
              types: [...model.types, clonedType],
            }
          : model
      )
    );
  };

  const printCutSheet = async (model, type) => {
    const parts = type.parts || [];
    const generatedDate = new Date().toLocaleDateString();
    const fileDate = new Date().toISOString().slice(0, 10);
    const preparedBy =
      prompt("Prepared by:", "Admiral Outdoor") || "Admiral Outdoor";

    const specs = type.specs || {};

    const specRows = [
      ["SKU", type.sku || specs.sku],
      ["Dimensions", type.dimensions || specs.dimensions],
      ["Seat Height", type.seatHeight || specs.seatHeight],
      ["Seat Width", type.seatWidth || specs.seatWidth],
      ["Seat Depth", type.seatDepth || specs.seatDepth],
      ["Stackable", type.stackable || specs.stackable],
      ["Material", type.material || specs.material],
    ].filter(([, value]) => value);

    const specsHtml =
      specRows.length > 0
        ? `
          <div style="
            margin-top:20px;
            border:1px solid #333;
            padding:12px;
            line-height:1.7;
            font-size:13px;
          ">
            ${specRows
              .map(
                ([label, value]) =>
                  `<div><b>${label}:</b> ${value}</div>`
              )
              .join("")}
          </div>
        `
        : "";

    const rows =
      parts.length > 0
        ? parts
            .map(
              (part) => `
                <tr>
                  <td>${part.name || ""}</td>
                  <td>${part.tube || ""}</td>
                  <td>${part.length || ""}</td>
                  <td>${part.qty || ""}</td>
                  <td>${part.angle || ""}</td>
                  <td>${part.notes || ""}</td>
                </tr>
              `
            )
            .join("")
        : `
            <tr>
              <td colspan="6">No parts saved yet.</td>
            </tr>
          `;

    const imageHtml = type.image
      ? `<img class="cut-image" crossorigin="anonymous" src="${type.image}" alt="" />`
      : "";

    const cutSheet = document.createElement("div");

    cutSheet.style.width = "900px";
    cutSheet.style.padding = "30px";
    cutSheet.style.background = "white";
    cutSheet.style.color = "#111";
    cutSheet.style.fontFamily = "Arial, sans-serif";
    cutSheet.style.position = "absolute";
    cutSheet.style.left = "-9999px";
    cutSheet.style.top = "0";

    cutSheet.innerHTML = `
      <div style="
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        border-bottom:2px solid #111;
        padding-bottom:16px;
        margin-bottom:20px;
      ">
        <div>
          <div style="
            font-size:32px;
            font-weight:bold;
            letter-spacing:2px;
          ">
            ADMIRAL
          </div>

          <div style="
            font-size:14px;
            margin-top:-4px;
            letter-spacing:1px;
            color:#555;
          ">
            OUTDOOR
          </div>

          <h1 style="
            margin:18px 0 6px;
            font-size:28px;
            color:#111;
          ">
            ${type.name}
          </h1>

          <h2 style="
            margin:0;
            font-size:18px;
            color:#111;
          ">
            ${model.name}
          </h2>

          <div style="margin-top:14px; line-height:1.7;">
            <div><b>Total Parts:</b> ${parts.length}</div>
            <div><b>Generated:</b> ${generatedDate}</div>
            <div><b>Prepared By:</b> ${preparedBy}</div>
          </div>
        </div>

        ${imageHtml}
      </div>

      ${specsHtml}

      <table style="
        width:100%;
        border-collapse:collapse;
        margin-top:20px;
      ">
        <thead>
          <tr>
            <th>Part</th>
            <th>Material</th>
            <th>Length</th>
            <th>Qty</th>
            <th>Angle</th>
            <th>Notes</th>
          </tr>
        </thead>

        <tbody>
          ${rows}
        </tbody>
      </table>

      <div style="
        margin-top:24px;
        font-size:12px;
        color:#555;
      ">
        Admiral Outdoor Production Cut Sheet
      </div>
    `;

    document.body.appendChild(cutSheet);

    const style = document.createElement("style");

    style.innerHTML = `
      table th,
      table td {
        border:1px solid #333;
        padding:8px;
        text-align:left;
        font-size:13px;
      }

      table th {
        background:#eee;
      }

      .cut-image {
        max-width:220px;
        max-height:150px;
        object-fit:contain;
        border:1px solid #ccc;
        padding:8px;
      }
    `;

    document.head.appendChild(style);

    const images = Array.from(cutSheet.querySelectorAll("img"));

    await Promise.all(
      images.map(
        (image) =>
          new Promise((resolve) => {
            if (image.complete && image.naturalWidth > 0) {
              resolve();
              return;
            }

            image.onload = resolve;
            image.onerror = resolve;
          })
      )
    );

    const canvas = await html2canvas(cutSheet, {
      scale: 2,
      useCORS: true,
      allowTaint: true,
      imageTimeout: 15000,
    });

    const imgData = canvas.toDataURL("image/png");

    const pdf = new jsPDF({
      orientation: "portrait",
      unit: "px",
      format: "a4",
    });

    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pdfWidth - 40;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let heightLeft = imgHeight;
    let position = 20;

    pdf.addImage(imgData, "PNG", 20, position, imgWidth, imgHeight);
    heightLeft -= pdfHeight - 40;

    while (heightLeft > 0) {
      position = heightLeft - imgHeight + 20;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 20, position, imgWidth, imgHeight);
      heightLeft -= pdfHeight - 40;
    }

    const safeName = `AdmiralOutdoor_${model.name}_${type.name}_${fileDate}`
      .replace(/[^a-z0-9]/gi, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");

    pdf.save(`${safeName}.pdf`);

    document.body.removeChild(cutSheet);
    document.head.removeChild(style);
  };



  const getFishbowlWeekSlot = (dueDateValue) => {
    const dueDateText = String(dueDateValue || "").trim();
    if (!dueDateText) return selectedScheduleWeek;

    const legacySlot = getLegacyWeekSlot(dueDateText);
    if (/^week\s+[1-5]$/i.test(dueDateText)) return legacySlot;

    const normalizedDueDate = cleanScheduleDateLabel(dueDateText).toLowerCase();
    const matchedIndex = scheduleWeeks.findIndex(
      (week) => cleanScheduleDateLabel(week).toLowerCase() === normalizedDueDate
    );

    return matchedIndex === -1 ? selectedScheduleWeek : matchedIndex;
  };

  const importFishbowlScheduleCsv = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {
      try {
        const rows = parseCsvText(String(reader.result || ""));

        const importedJobs = rows
          .map((row) => {
            const collection = findCsvValue(row, "collection") || "Fishbowl Import";
            const furniture = findCsvValue(row, "furniture");
            const sku = findCsvValue(row, "sku");
            const dueDate = findCsvValue(row, "dueDate");
            const notes = findCsvValue(row, "notes");
            const qtyNeeded = parseQuantity(findCsvValue(row, "qty"));

            if (!furniture && !sku) return null;

            const productSpecs = {
              sku,
              dimensions: "",
              seatHeight: "",
              seatWidth: "",
              seatDepth: "",
              stackable: "",
              material: "",
            };

            return {
              id: makeId(),
              modelId: "fishbowl-import",
              typeId: sku || makeId(),
              collection,
              furniture: furniture || sku,
              image: null,
              sku,
              dimensions: "",
              seatHeight: "",
              seatWidth: "",
              seatDepth: "",
              stackable: "",
              material: "",
              specs: productSpecs,
              partsSnapshot: [],
              qtyNeeded,
              qtyComplete: 0,
              weekSlot: getFishbowlWeekSlot(dueDate),
              dueDate,
              notes: notes ? `Fishbowl import: ${notes}` : "Fishbowl import",
              status: "Scheduled",
              createdAt: new Date().toISOString(),
              source: "Fishbowl CSV",
            };
          })
          .filter(Boolean);

        if (importedJobs.length === 0) {
          alert("No schedule rows were found. Make sure the CSV has item/product and quantity columns.");
          event.target.value = "";
          return;
        }

        const preview = importedJobs
          .slice(0, 8)
          .map((job) => `• ${job.collection} / ${job.furniture} — Qty ${job.qtyNeeded}${job.sku ? ` — SKU ${job.sku}` : ""}`)
          .join("\n");

        const confirmed = window.confirm(
          `Import ${importedJobs.length} Fishbowl schedule row(s) into ForgeFlow?\n\nPreview:\n${preview}${importedJobs.length > 8 ? "\n..." : ""}`
        );

        if (!confirmed) {
          event.target.value = "";
          return;
        }

        setSchedule([...importedJobs, ...schedule]);
        setView("Schedule");
        setFishbowlImportSummary(
          `Imported ${importedJobs.length} Fishbowl row(s) from ${file.name}. Autosave/realtime will sync this to Supabase.`
        );
      } catch (error) {
        console.error("Fishbowl CSV import failed:", error);
        alert("Could not import that CSV. Export from Fishbowl as CSV and try again.");
      }

      event.target.value = "";
    };

    reader.readAsText(file);
  };

  const exportBackup = () => {
    const backup = {
      appName: "Admiral Outdoor Production App",
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      models,
      schedule,
      liveJobs,
      scheduleWeeks,
    };

    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const today = new Date().toISOString().slice(0, 10);

    link.href = url;
    link.download = `admiral-production-backup-${today}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const importBackup = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();

    reader.onload = async () => {
      try {
        const backup = JSON.parse(reader.result);

        const hasValidData =
          Array.isArray(backup.models) &&
          Array.isArray(backup.schedule) &&
          Array.isArray(backup.liveJobs) &&
          Array.isArray(backup.scheduleWeeks);

        if (!hasValidData) {
          alert("That backup file does not look like a valid production app backup.");
          event.target.value = "";
          return;
        }

        const confirmed = window.confirm(
          "Import this backup? This will replace the shared cloud data for everyone who logs into this app."
        );

        if (!confirmed) {
          event.target.value = "";
          return;
        }

        const importedData = {
          models: backup.models,
          schedule: backup.schedule,
          liveJobs: backup.liveJobs,
          scheduleWeeks: backup.scheduleWeeks,
        };

        applyAppData(importedData);
        setSelectedModelId(null);
        setOpenTypeId(null);
        setView("Models");

        const savedToCloud = await saveSharedAppData(importedData, { snapshotReason: "manual-import" });

        if (savedToCloud) {
          alert("Backup imported and saved to Supabase cloud. Other devices should see it after refresh/login.");
        } else {
          alert("Backup imported on this device, but the Supabase cloud save failed. Check the browser console and app_data table.");
        }
      } catch (error) {
        console.error("Import failed:", error);
        alert("Could not import that backup file. Make sure it is the JSON backup exported from this app.");
      }

      event.target.value = "";
    };

    reader.readAsText(file);
  };

  const startEditType = (type) => {
    setEditingTypeId(type.id);
    setEditingTypeName(type.name);
    setEditingTypeImage(type.image || null);
  };

  const cancelEditType = () => {
    setEditingTypeId(null);
    setEditingTypeName("");
    setEditingTypeImage(null);
  };

  const saveEditType = () => {
    if (!editingTypeName.trim()) return;

    setModels(
      models.map((model) =>
        model.id === selectedModelId
          ? {
              ...model,
              types: model.types.map((type) =>
                type.id === editingTypeId
                  ? {
                      ...type,
                      name: editingTypeName.trim(),
                      image: editingTypeImage,
                    }
                  : type
              ),
            }
          : model
      )
    );

    cancelEditType();
  };

  const deleteType = (typeId) => {
    const typeToDelete = selectedModel?.types?.find((type) => type.id === typeId);
    if (!confirmPermanentDelete(`the furniture piece "${typeToDelete?.name || "this furniture"}"`)) return;

    setModels(
      models.map((model) =>
        model.id === selectedModelId
          ? {
              ...model,
              types: model.types.filter((type) => type.id !== typeId),
            }
          : model
      )
    );

    if (openTypeId === typeId) {
      setOpenTypeId(null);
    }
  };

  const addOrUpdatePart = (typeId) => {
    if (!partForm.name.trim()) return;

    setModels(
      models.map((model) =>
        model.id === selectedModelId
          ? {
              ...model,
              types: model.types.map((type) => {
                if (type.id !== typeId) return type;

                const updatedParts = editingPartId
                  ? type.parts.map((part) =>
                      part.id === editingPartId
                        ? {
                            ...partForm,
                            id: editingPartId,
                          }
                        : part
                    )
                  : [
                      ...type.parts,
                      {
                        ...partForm,
                        id: makeId(),
                      },
                    ];

                return {
                  ...type,
                  parts: updatedParts,
                };
              }),
            }
          : model
      )
    );

    setPartForm(emptyPartForm);
    setEditingPartId(null);
  };

  const editPart = (part) => {
    setPartForm({
      name: part.name || "",
      tube: part.tube || "",
      length: part.length || "",
      qty: part.qty || "",
      angle: part.angle || "",
      notes: part.notes || "",
    });

    setEditingPartId(part.id);
  };

  const cancelEditPart = () => {
    setPartForm(emptyPartForm);
    setEditingPartId(null);
  };

  const deletePart = (typeId, partId) => {
    const currentType = selectedModel?.types?.find((type) => type.id === typeId);
    const partToDelete = currentType?.parts?.find((part) => part.id === partId);
    if (!confirmPermanentDelete(`the part "${partToDelete?.name || "this part"}"`)) return;

    setModels(
      models.map((model) =>
        model.id === selectedModelId
          ? {
              ...model,
              types: model.types.map((type) =>
                type.id === typeId
                  ? {
                      ...type,
                      parts: type.parts.filter((part) => part.id !== partId),
                    }
                  : type
              ),
            }
          : model
      )
    );
  };

  const addToSchedule = (type) => {
    if (!selectedModel) return;

    const qtyNeeded = Math.max(1, Number(scheduleForm.qty || 1));
    const productSpecs = getItemSpecs(type);

    const job = {
      id: makeId(),
      modelId: selectedModel.id,
      typeId: type.id,
      collection: selectedModel.name,
      furniture: type.name,
      image: type.image,
      sku: productSpecs.sku,
      dimensions: productSpecs.dimensions,
      seatHeight: productSpecs.seatHeight,
      seatWidth: productSpecs.seatWidth,
      seatDepth: productSpecs.seatDepth,
      stackable: productSpecs.stackable,
      material: productSpecs.material,
      specs: productSpecs,
      partsSnapshot: type.parts || [],
      qtyNeeded,
      qtyComplete: 0,
      weekSlot: Number(scheduleForm.weekSlot || 0),
      dueDate: scheduleForm.dueDate,
      notes: scheduleForm.notes,
      status: "Scheduled",
      createdAt: new Date().toISOString(),
    };

    setSchedule([job, ...schedule]);

    setScheduleForm({
      qty: 1,
      weekSlot: scheduleForm.weekSlot,
      dueDate: "",
      notes: "",
    });
  };

  const adjustScheduleQty = (jobId, amount) => {
    setSchedule(
      schedule.map((job) => {
        if (job.id !== jobId) return job;

        const nextQty = Math.max(1, Number(job.qtyNeeded || 1) + amount);
        const nextComplete = Math.min(Number(job.qtyComplete || 0), nextQty);

        return {
          ...job,
          qtyNeeded: nextQty,
          qtyComplete: nextComplete,
          status:
            nextComplete >= nextQty
              ? "Complete"
              : job.status === "Complete"
              ? "Scheduled"
              : job.status,
          completedAt: nextComplete >= nextQty ? job.completedAt || new Date().toISOString() : null,
        };
      })
    );
  };

  const toggleScheduleComplete = (jobId) => {
    setSchedule(
      schedule.map((job) => {
        if (job.id !== jobId) return job;

        const isComplete = job.status === "Complete";

        return {
          ...job,
          qtyComplete: isComplete ? 0 : job.qtyNeeded,
          status: isComplete ? "Scheduled" : "Complete",
          completedAt: isComplete ? null : job.completedAt || new Date().toISOString(),
        };
      })
    );
  };

  const moveScheduledJobWeek = (jobId, direction) => {
    setSchedule(
      schedule.map((job) => {
        if (job.id !== jobId) return job;

        const currentIndex = getJobWeekSlot(job);

        const nextIndex = Math.min(
          scheduleWeeks.length - 1,
          Math.max(0, currentIndex + direction)
        );

        return {
          ...job,
          weekSlot: nextIndex,
        };
      })
    );
  };

  const duplicateScheduledJob = (job) => {
    setSchedule([
      {
        ...job,
        id: makeId(),
        qtyComplete: 0,
        status: "Scheduled",
        weekSlot: getJobWeekSlot(job),
        createdAt: new Date().toISOString(),
      },
      ...schedule,
    ]);
  };

  const removeScheduledJob = (jobId) => {
    const jobToDelete = schedule.find((job) => job.id === jobId);
    if (!confirmPermanentDelete(`the scheduled job "${jobToDelete?.furniture || "this job"}"`)) return;

    setSchedule(schedule.filter((job) => job.id !== jobId));
    setLiveJobs(liveJobs.filter((job) => job.scheduleId !== jobId));
  };

  const releaseToProduction = (scheduleJob) => {
    const remaining =
      Number(scheduleJob.qtyNeeded || 0) - Number(scheduleJob.qtyComplete || 0);

    if (remaining <= 0) return;

    const alreadyLive = liveJobs.some(
      (job) => job.scheduleId === scheduleJob.id && job.stage < STAGES.length - 1
    );

    if (alreadyLive) return;

    const productSpecs = getItemSpecs(scheduleJob);

    const liveJob = {
      id: makeId(),
      scheduleId: scheduleJob.id,
      collection: scheduleJob.collection,
      furniture: scheduleJob.furniture,
      image: scheduleJob.image,
      sku: productSpecs.sku,
      dimensions: productSpecs.dimensions,
      seatHeight: productSpecs.seatHeight,
      seatWidth: productSpecs.seatWidth,
      seatDepth: productSpecs.seatDepth,
      stackable: productSpecs.stackable,
      material: productSpecs.material,
      specs: productSpecs,
      dueDate: getScheduleDateLabel(scheduleWeeks, scheduleJob),
      weekSlot: getJobWeekSlot(scheduleJob),
      notes: scheduleJob.notes,
      partsSnapshot: scheduleJob.partsSnapshot || [],
      qty: remaining,
      stage: 0,
      stageCompleteQty: 0,
      partsReady: false,
      startedAt: new Date().toISOString(),
    };

    setLiveJobs([liveJob, ...liveJobs]);

    setSchedule(
      schedule.map((job) =>
        job.id === scheduleJob.id
          ? {
              ...job,
              status: "In Production",
            }
          : job
      )
    );
  };

  const updateStageQty = (jobId, amount) => {
    setLiveJobs(
      liveJobs.map((job) =>
        job.id === jobId
          ? {
              ...job,
              stageCompleteQty: Math.min(
                job.qty,
                Math.max(0, Number(job.stageCompleteQty || 0) + amount)
              ),
            }
          : job
      )
    );
  };

  const togglePartsReady = (jobId) => {
    setLiveJobs(
      liveJobs.map((job) =>
        job.id === jobId
          ? {
              ...job,
              partsReady: !job.partsReady,
            }
          : job
      )
    );
  };

  const moveLiveJob = (jobId) => {
    const job = liveJobs.find((item) => item.id === jobId);
    if (!job) return;

    if (job.stage === 0 && !job.partsReady) return;

    const nextStage = Math.min(job.stage + 1, STAGES.length - 1);

    setLiveJobs(
      liveJobs.map((item) =>
        item.id === jobId
          ? {
              ...item,
              stage: nextStage,
              stageCompleteQty: 0,
            }
          : item
      )
    );

    if (nextStage === STAGES.length - 1) {
      setSchedule(
        schedule.map((scheduleJob) => {
          if (scheduleJob.id !== job.scheduleId) return scheduleJob;

          const newComplete = Math.min(
            scheduleJob.qtyNeeded,
            Number(scheduleJob.qtyComplete || 0) + Number(job.qty || 0)
          );

          return {
            ...scheduleJob,
            qtyComplete: newComplete,
            status:
              newComplete >= scheduleJob.qtyNeeded
                ? "Complete"
                : "In Production",
            completedAt: newComplete >= scheduleJob.qtyNeeded ? scheduleJob.completedAt || new Date().toISOString() : null,
          };
        })
      );
    }
  };

  const addLiveJobToStock = (jobId) => {
    const job = liveJobs.find((item) => item.id === jobId);
    if (!job) return;

    if (!window.confirm(`Mark "${job.furniture}" complete and remove it from live production?`)) return;

    setSchedule(
      schedule.map((scheduleJob) => {
        if (scheduleJob.id !== job.scheduleId) return scheduleJob;

        const newComplete = Math.min(
          Number(scheduleJob.qtyNeeded || 0),
          Number(scheduleJob.qtyComplete || 0) + Number(job.qty || 0)
        );

        return {
          ...scheduleJob,
          qtyComplete: newComplete,
          status: newComplete >= Number(scheduleJob.qtyNeeded || 0) ? "Complete" : "In Production",
          completedAt: newComplete >= Number(scheduleJob.qtyNeeded || 0) ? scheduleJob.completedAt || new Date().toISOString() : null,
        };
      })
    );

    setLiveJobs(liveJobs.filter((item) => item.id !== jobId));
  };

  const removeLiveJob = (jobId) => {
    const jobToDelete = liveJobs.find((job) => job.id === jobId);
    if (!confirmPermanentDelete(`the live job "${jobToDelete?.furniture || "this job"}"`)) return;

    setLiveJobs(liveJobs.filter((job) => job.id !== jobId));
  };

  const clearCompletedLiveJobs = () => {
    const completedLiveJobs = liveJobs.filter((job) => job.stage >= STAGES.length - 1);

    if (completedLiveJobs.length === 0) {
      alert("There are no completed live jobs to remove right now.");
      return;
    }

    if (!window.confirm(`Clear ${completedLiveJobs.length} completed live job${completedLiveJobs.length === 1 ? "" : "s"} from the Live board?`)) return;

    setLiveJobs(liveJobs.filter((job) => job.stage < STAGES.length - 1));
  };

  const clearCompletedScheduleForWeek = (weekIndex) => {
    const completedCount = schedule.filter(
      (job) => getJobWeekSlot(job) === weekIndex && job.status === "Complete"
    ).length;

    if (completedCount === 0) return;

    if (!window.confirm(`Remove ${completedCount} completed job${completedCount === 1 ? "" : "s"} from this week?`)) return;

    setSchedule(
      schedule.filter(
        (job) => !(getJobWeekSlot(job) === weekIndex && job.status === "Complete")
      )
    );
  };

  const liveForStage = (stageIndex) => {
    return filteredLiveJobs.filter((job) => job.stage === stageIndex);
  };

  const departmentStageIndexes = (department) => {
    const index = STAGES.indexOf(department);
    if (index <= 0) return index === 0 ? [0] : [];
    return [index - 1, index];
  };

  const isTableJob = (job) => {
    const text = `${job.collection || ""} ${job.furniture || ""}`;
    return /table/i.test(job.furniture || "") || /destin/i.test(text);
  };

  const departmentPanelsForView = (department) => {
    if (department === "Welding") {
      const weldingJobs = liveForStage(1);

      return [
        { title: "Fabrication", stageName: "Fabrication", jobs: liveForStage(0) },
        { title: "Welding", stageName: "Welding", jobs: weldingJobs.filter((job) => !isTableJob(job)) },
        { title: "Tables", stageName: "Welding", jobs: weldingJobs.filter(isTableJob) },
      ];
    }

    return departmentStageIndexes(department).map((stageIndex) => ({
      title: STAGES[stageIndex],
      stageName: STAGES[stageIndex],
      jobs: liveForStage(stageIndex),
    }));
  };

  const fullLivePanelsForView = (department) => {
    if (department === "Welding") {
      const weldingJobs = liveForStage(1);

      return [
        { title: "Welding", stageName: "Welding", jobs: weldingJobs.filter((job) => !isTableJob(job)) },
        { title: "Tables", stageName: "Welding", jobs: weldingJobs.filter(isTableJob) },
      ];
    }

    const stageIndex = STAGES.indexOf(department);

    return stageIndex === -1
      ? []
      : [
          {
            title: department,
            stageName: department,
            jobs: liveForStage(stageIndex),
          },
        ];
  };

  const getShopMessageFromLabel = () => {
    if (currentRole === "Employee") return employeeDepartment;
    if (["Supervisor"].includes(currentRole)) return "Supervisor";
    return currentRole || "Team";
  };

  const loadShopMessages = async () => {
    const { data, error } = await supabase
      .from("shop_messages")
      .select("id, created_at, sender_name, sender_role, department, message, attachment_url, attachment_name, acknowledgements")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("Could not load shop messages:", error);
      return;
    }

    setShopMessages(Array.isArray(data) ? data : []);
  };

  const compressShopMessageImage = (file) => {
    return new Promise((resolve, reject) => {
      if (!file) {
        resolve(null);
        return;
      }

      const reader = new FileReader();

      reader.onload = () => {
        const image = new Image();

        image.onload = () => {
          const maxSize = 1200;
          const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
          const canvas = document.createElement("canvas");

          canvas.width = Math.round(image.width * scale);
          canvas.height = Math.round(image.height * scale);

          const context = canvas.getContext("2d");
          context.drawImage(image, 0, 0, canvas.width, canvas.height);

          resolve(canvas.toDataURL("image/jpeg", 0.78));
        };

        image.onerror = reject;
        image.src = reader.result;
      };

      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handleShopMessagePhoto = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const compressedImage = await compressShopMessageImage(file);
      setShopMessagePhoto(compressedImage);
      setShopMessagePhotoName(file.name || "Attached photo");
    } catch (error) {
      console.error("Could not attach photo:", error);
      alert("Could not attach that photo. Try a different image.");
    }

    event.target.value = "";
  };

  const clearShopMessagePhoto = () => {
    setShopMessagePhoto(null);
    setShopMessagePhotoName("");
  };

  const getCurrentAckId = () => {
    return currentUser?.id || currentUser?.email || currentUser?.username || currentRole || "unknown-user";
  };

  const hasAcknowledgedMessage = (message) => {
    const acknowledgements = Array.isArray(message.acknowledgements) ? message.acknowledgements : [];
    return acknowledgements.some((ack) => ack.userId === getCurrentAckId());
  };

  const toggleShopMessageAck = async (message) => {
    if (!currentUser || !message?.id) return;

    const acknowledgements = Array.isArray(message.acknowledgements) ? message.acknowledgements : [];
    const currentAckId = getCurrentAckId();
    const alreadyAcknowledged = acknowledgements.some((ack) => ack.userId === currentAckId);

    const nextAcknowledgements = alreadyAcknowledged
      ? acknowledgements.filter((ack) => ack.userId !== currentAckId)
      : [
          ...acknowledgements,
          {
            userId: currentAckId,
            name: currentUser.displayName || currentUser.username || currentRole,
            role: currentRole,
            department: currentRole === "Employee" ? employeeDepartment : getShopMessageFromLabel(),
            at: new Date().toISOString(),
          },
        ];

    setShopMessages((currentMessages) =>
      currentMessages.map((item) =>
        item.id === message.id ? { ...item, acknowledgements: nextAcknowledgements } : item
      )
    );

    const { error } = await supabase
      .from("shop_messages")
      .update({ acknowledgements: nextAcknowledgements })
      .eq("id", message.id);

    if (error) {
      console.error("Could not update thumbs up:", error);
      alert("Could not update thumbs up. Check Supabase policies and try again.");
      loadShopMessages();
    }
  };

  const sendShopMessage = async (event) => {
    event.preventDefault();

    const cleanMessage = shopMessageText.trim();
    if (!cleanMessage || !currentUser) return;

    const { error } = await supabase.from("shop_messages").insert({
      sender_name: currentUser.displayName || currentUser.username || currentRole,
      sender_role: getShopMessageFromLabel(),
      department: shopMessageTo,
      message: cleanMessage,
      attachment_url: shopMessagePhoto,
      attachment_name: shopMessagePhotoName,
      acknowledgements: [],
    });

    if (error) {
      console.error("Could not send shop message:", error);
      alert("Could not send that message. Check Supabase and try again.");
      return;
    }

    setShopMessageText("");
    clearShopMessagePhoto();
  };

  const deleteShopMessage = async (messageId) => {
    if (!canDelete && currentRole !== "Admin") return;
    if (!window.confirm("Delete this shop note?")) return;

    const { error } = await supabase
      .from("shop_messages")
      .delete()
      .eq("id", messageId);

    if (error) {
      console.error("Could not delete shop message:", error);
      alert("Could not delete that message.");
    }
  };

  const formatMessageTime = (value) => {
    try {
      return new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch (error) {
      return "";
    }
  };

  const handleLogin = async (event) => {
    event.preventDefault();

    setLoginError("");

    const username = loginForm.username.trim().toLowerCase();
    const password = loginForm.password;

    if (!username || !password) {
      setLoginError("Enter your username and password.");
      return;
    }

    const loginUser = LOGIN_USERS.find(
      (item) => item.username.toLowerCase() === username
    );

    if (!loginUser) {
      setLoginError("Invalid username or password.");
      return;
    }

    setAuthLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: loginUser.email,
      password,
    });

    if (error) {
      setLoginError(error.message || "Invalid username or password.");
      setAuthLoading(false);
      return;
    }

    await loadSupabaseUser(data?.user || null);
    setLoginForm({ username: "", password: "" });
    setLoginError("");
    setAuthLoading(false);
  };

  const handleLogout = async () => {
    if (!window.confirm("Log out of this device?")) return;

    try {
      await supabase.auth.signOut({ scope: "global" });
    } catch (error) {
      console.error("Logout failed:", error);
    }

    // Clear only login/session-related storage. Keep production data backups intact.
    const storageKeysToRemove = [];

    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);

      if (
        key === "loggedInUser" ||
        key === "currentRole" ||
        key === "employeeDepartment" ||
        key?.startsWith("sb-") ||
        key?.toLowerCase().includes("supabase") ||
        key?.toLowerCase().includes("auth-token")
      ) {
        storageKeysToRemove.push(key);
      }
    }

    storageKeysToRemove.forEach((key) => localStorage.removeItem(key));
    sessionStorage.clear();

    if (window.caches) {
      try {
        const cacheNames = await window.caches.keys();
        await Promise.all(cacheNames.map((cacheName) => window.caches.delete(cacheName)));
      } catch (error) {
        console.warn("Could not clear browser cache storage during logout:", error);
      }
    }

    cloudReadyRef.current = false;
    setCloudDataLoaded(false);
    setCurrentUser(null);
    setLoginForm({ username: "", password: "" });
    setLoginError("");
    setView("Models");

    // Force the browser/PWA shell to re-read the logged-out state.
    window.location.replace(`${window.location.origin}${window.location.pathname}?logout=${Date.now()}`);
  };

  const handleEmployeeDepartmentChange = (department) => {
    setEmployeeDepartment(department);
    setEmployeePanelTab(department);

    if (currentRole === "Employee") {
      setView(department);
    }
  };

  const StageBadge = ({ stage }) => {
    const stageName = STAGES[stage];
    return (
      <span className={`stage-badge stage-${stageSlug(stageName)}`}>
        {stageName}
      </span>
    );
  };

  const JobCard = ({ job }) => {
    const isFabrication = job.stage === 0;
    const isComplete = job.stage === STAGES.length - 1;
    const productSpecs = getItemSpecs(job);
    const linkedScheduleJob = schedule.find((item) => item.id === job.scheduleId);
    const dueLabel = getScheduleDateLabel(scheduleWeeks, job.dueDate ? job : linkedScheduleJob || job);
    const canViewCutSheet = canOperateJobs && (job.stage === 0 || job.stage === 1);
    const isReadOnlyCard = !canOperateJobs;

    return (
      <div className={isReadOnlyCard ? "job-card compact-job-card read-only-job-card" : "job-card compact-job-card"}>
        <div className="job-card-left">
          <div className="job-head compact-job-head">
            {job.image && <img src={job.image} className="job-img" alt="" />}

            <div className="job-title-block">
              <h3>{job.furniture}</h3>
              {productSpecs.sku && (
                <p className="sku-line">SKU: {productSpecs.sku}</p>
              )}
              <StageBadge stage={job.stage} />
            </div>
          </div>

          <div className="info-grid job-spec-grid compact-job-meta">
            <p>
              <b>Qty:</b> {job.qty}
            </p>
            <p>
              <b>Due:</b> {dueLabel}
            </p>
          </div>

          {job.notes && <p className="note compact-note">{job.notes}</p>}
        </div>

        <div className="job-card-right">
          {canViewCutSheet && (
            <button
              className="wide secondary"
              onClick={() =>
                setCutSheetView({
                  model: { name: job.collection },
                  type: {
                    ...job,
                    name: job.furniture,
                    image: job.image,
                    parts: job.partsSnapshot || [],
                  },
                })
              }
            >
              View Cut Sheet
            </button>
          )}

          {isFabrication && !isComplete && (
            <>
              <div className={job.partsReady ? "status good" : "status warning"}>
                {job.partsReady
                  ? "Parts are ready for welding"
                  : "Cutting / fabrication in progress"}
              </div>

              {canOperateJobs && (
                <div className="button-row compact-action-row">
                  <button onClick={() => togglePartsReady(job.id)}>
                    {job.partsReady ? "Mark Not Ready" : "Mark Parts Ready"}
                  </button>

                  <button
                    disabled={!job.partsReady}
                    onClick={() => moveLiveJob(job.id)}
                  >
                    Send To Welding
                  </button>
                </div>
              )}
            </>
          )}

          {!isFabrication && !isComplete && (
            <>
              <div className="progress-box compact-progress-box">
                <div className="progress-line">
                  <span>
                    Stage Progress: {job.stageCompleteQty} / {job.qty}
                  </span>
                  <span>
                    {Math.round((Number(job.stageCompleteQty || 0) / job.qty) * 100)}%
                  </span>
                </div>

                <div className="bar">
                  <div
                    className="bar-fill"
                    style={{
                      width: `${Math.min(
                        100,
                        (Number(job.stageCompleteQty || 0) / job.qty) * 100
                      )}%`,
                    }}
                  />
                </div>
              </div>

              {canOperateJobs && (
                <>
                  <div className="button-row compact-action-row">
                    <button onClick={() => updateStageQty(job.id, 1)}>+1</button>
                    <button onClick={() => updateStageQty(job.id, 5)}>+5</button>
                    <button onClick={() => updateStageQty(job.id, 10)}>+10</button>
                    <button onClick={() => updateStageQty(job.id, -1)}>-1</button>
                  </div>

                  {job.stage === STAGES.indexOf("Assembly") && ["Supervisor", "Developer"].includes(currentRole) ? (
                    <div className="button-row compact-action-row">
                      <button onClick={() => addLiveJobToStock(job.id)}>
                        Complete
                      </button>
                      <button onClick={() => moveLiveJob(job.id)}>
                        Move To Paint Line
                      </button>
                    </div>
                  ) : (
                    <button className="wide" onClick={() => moveLiveJob(job.id)}>
                      Move To {STAGES[job.stage + 1]}
                    </button>
                  )}
                </>
              )}
            </>
          )}

          {isComplete && <div className="status good">Order Sent / Complete</div>}

          {canRemoveLiveJob && (
            <button className="danger wide" onClick={() => removeLiveJob(job.id)}>
              Remove Live Job
            </button>
          )}
        </div>
      </div>
    );
  };


  const DevProductionDashboard = () => {
    const now = new Date();
    const todayLabel = now.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const timeLabel = now.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });

    const stageCards = STAGES.slice(0, 5).map((stage, index) => {
      const jobs = liveForStage(index);
      const delayedCount = jobs.filter((job) => {
        const text = `${job.status || ""} ${job.notes || ""}`.toLowerCase();
        return text.includes("delay") || text.includes("late") || text.includes("hold");
      }).length;

      const qty = jobs.reduce((sum, job) => sum + Number(job.qty || 0), 0);

      return {
        stage,
        count: jobs.length,
        qty,
        delayedCount,
      };
    });

    const activeJobs = liveJobs.filter((job) => job.stage < STAGES.length - 1);
    const completedToday = schedule.filter((job) => {
      if (job.status !== "Complete" || !job.completedAt) return false;
      return new Date(job.completedAt).toDateString() === now.toDateString();
    });
    const delayedJobs = schedule.filter((job) => {
      const text = `${job.status || ""} ${job.notes || ""}`.toLowerCase();
      return text.includes("delay") || text.includes("late") || text.includes("hold");
    });

    const dashboardMessages = shopMessages.slice(0, 4);
    const topJobs = activeJobs.slice(0, 5);
    const delayedJobRows = delayedJobs.slice(0, 4);
    const recentActivity = [
      ...liveJobs.slice(0, 4).map((job) => ({
        id: `live-${job.id}`,
        title: `${job.collection || "Job"} ${job.furniture || ""}`.trim(),
        detail: `Active in ${STAGES[job.stage] || "Production"}`,
        badge: (job.furniture || job.collection || "J").slice(0, 1).toUpperCase(),
        time: job.startedAt ? formatMessageTime(job.startedAt) : "Live now",
      })),
      ...dashboardMessages.slice(0, 2).map((message) => ({
        id: `msg-${message.id}`,
        title: message.sender_name || "Team Message",
        detail: message.message || "New message",
        badge: (message.sender_name || "M").slice(0, 1).toUpperCase(),
        time: formatMessageTime(message.created_at),
      })),
    ].slice(0, 6);

    const totalStageCount = Math.max(1, stageCards.reduce((sum, item) => sum + item.count, 0));

    return (
      <div className="tv-dashboard-page">
        <header className="tv-dashboard-header">
          <div className="tv-dashboard-brand">
            <span className="tv-dashboard-star" aria-hidden="true">✦</span>
            <div>
              <h1>ADMIRAL</h1>
              <p>OUTDOOR</p>
            </div>
          </div>

          <div className="tv-dashboard-title">
            <h2>PRODUCTION DASHBOARD</h2>
            <span>Developer Preview</span>
          </div>

          <div className="tv-dashboard-clock">
            <b>{timeLabel}</b>
            <span>{todayLabel}</span>
          </div>
        </header>

        <div className="tv-dashboard-grid">
          <section className="tv-panel tv-summary-panel">
            <h3>Today&apos;s Summary</h3>

            <div className="tv-summary-list">
              <div>
                <span>Active Jobs</span>
                <b>{activeJobs.length}</b>
              </div>
              <div>
                <span>Completed Today</span>
                <b>{completedToday.length}</b>
              </div>
              <div>
                <span>Scheduled Qty</span>
                <b>{dashboard.scheduledQty}</b>
              </div>
              <div>
                <span>Delayed / Hold</span>
                <b>{delayedJobs.length}</b>
              </div>
              <div>
                <span>Messages</span>
                <b>{shopMessages.length}</b>
              </div>
            </div>
          </section>

          <section className="tv-panel tv-flow-panel">
            <h3>Production Flow</h3>

            <div className="tv-flow-row">
              {stageCards.map((item, index) => (
                <div key={item.stage} className={`tv-stage-card tv-stage-${stageSlug(item.stage)}`}>
                  <span>{item.stage}</span>
                  <b>{item.count}</b>
                  <small>{item.qty} Qty</small>
                  <em>{item.delayedCount} Delayed</em>
                  {index < stageCards.length - 1 && <i aria-hidden="true">→</i>}
                </div>
              ))}
            </div>

            <div className="tv-department-load">
              <h4>Department Load</h4>
              <div className="tv-load-grid">
                {stageCards.map((item) => {
                  const percent = Math.round((item.count / totalStageCount) * 100);
                  return (
                    <div key={item.stage} className="tv-load-row">
                      <div>
                        <span>{item.stage}</span>
                        <b>{percent}%</b>
                      </div>
                      <div className="tv-load-bar">
                        <span style={{ width: `${Math.max(6, percent)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="tv-panel tv-activity-panel">
            <h3>Live Activity</h3>

            {recentActivity.length === 0 ? (
              <div className="tv-empty">No live activity yet.</div>
            ) : (
              <div className="tv-activity-list">
                {recentActivity.map((activity) => (
                  <article key={activity.id}>
                    <span>{activity.badge}</span>
                    <div>
                      <b>{activity.title}</b>
                      <p>{activity.detail}</p>
                    </div>
                    <em>{activity.time}</em>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="tv-panel tv-table-panel">
            <h3>Top Jobs In Progress</h3>

            {topJobs.length === 0 ? (
              <div className="tv-empty">No active jobs in production.</div>
            ) : (
              <div className="tv-table-list">
                {topJobs.map((job) => {
                  const percent = Math.round((Number(job.stageCompleteQty || 0) / Math.max(1, Number(job.qty || 1))) * 100);
                  return (
                    <article key={job.id}>
                      <span>{job.collection}</span>
                      <b>{job.furniture}</b>
                      <small>{STAGES[job.stage]}</small>
                      <div className="tv-mini-progress"><i style={{ width: `${Math.min(100, percent)}%` }} /></div>
                      <em>{percent}%</em>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="tv-panel tv-table-panel">
            <h3>Delayed Jobs</h3>

            {delayedJobRows.length === 0 ? (
              <div className="tv-empty">No delayed jobs flagged.</div>
            ) : (
              <div className="tv-table-list delayed-tv-list">
                {delayedJobRows.map((job) => (
                  <article key={job.id}>
                    <span>{job.collection}</span>
                    <b>{job.furniture}</b>
                    <small>{job.status}</small>
                    <em>{job.dueDate || getScheduleDateLabel(scheduleWeeks, job)}</em>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="tv-panel tv-messages-panel">
            <h3>Messages</h3>

            {dashboardMessages.length === 0 ? (
              <div className="tv-empty">No recent messages.</div>
            ) : (
              <div className="tv-message-list">
                {dashboardMessages.map((message) => (
                  <article key={message.id}>
                    <span>{message.department || "Everyone"}</span>
                    <b>{message.message}</b>
                    <em>{formatMessageTime(message.created_at)}</em>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    );
  };

  if (authLoading) {
    return (
      <div className="login-page premium-login-page">
        <div className="login-atmosphere" />

        <div className="login-shell">
          <div className="login-hero-brand">
            <div className="login-compass-star" aria-hidden="true" />
            <div className="login-logo">ADMIRAL</div>
            <div className="login-logo-sub">OUTDOOR</div>
          </div>

          <div className="login-card premium-login-card">
            <h1 className="login-title">Loading...</h1>
            <p className="muted login-instructions">
              Checking secure session and shared company data.
            </p>

            <div className="login-help powered-by">
              <span>
                Powered by <b>ForgeFlow</b> <span className="powered-by-tech">Technologies</span>
              </span>
              <img
                src="/forgeflow-ff-logo.png"
                alt="ForgeFlow"
                className="powered-by-logo"
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="login-page premium-login-page">
        <div className="login-atmosphere" />

        <div className="login-shell">
          <div className="login-hero-brand">
            <div className="login-compass-star" aria-hidden="true" />
            <div className="login-logo">ADMIRAL</div>
            <div className="login-logo-sub">OUTDOOR</div>
          </div>

          <form className="login-card premium-login-card" onSubmit={handleLogin}>
            <h1 className="login-title">Welcome Back</h1>
            <p className="muted login-instructions">
              Sign in to continue
            </p>

            <label className="login-field-label" htmlFor="login-username">
              Username
            </label>
            <div className="login-input-wrap">
              <span className="login-input-icon" aria-hidden="true">♙</span>
              <input
                id="login-username"
                autoFocus
                value={loginForm.username}
                onChange={(e) =>
                  setLoginForm({ ...loginForm, username: e.target.value })
                }
                placeholder="Username"
              />
            </div>

            <label className="login-field-label" htmlFor="login-password">
              Password
            </label>
            <div className="login-input-wrap">
              <span className="login-input-icon" aria-hidden="true">▣</span>
              <input
                id="login-password"
                type="password"
                value={loginForm.password}
                onChange={(e) =>
                  setLoginForm({ ...loginForm, password: e.target.value })
                }
                placeholder="Password"
              />
            </div>

            {loginError && <div className="login-error">{loginError}</div>}

            <button className="login-submit" type="submit">
              SIGN IN
            </button>

            <div className="login-help powered-by">
              <span>
                Powered by <b>ForgeFlow</b> <span className="powered-by-tech">Technologies</span>
              </span>
              <img
                src="/forgeflow-ff-logo.png"
                alt="ForgeFlow"
                className="powered-by-logo"
              />
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="top-nav clean-nav">
        <input
          className="search"
          placeholder="Search everything... name, SKU, collection..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div className="nav-button-group">
          {PRIMARY_VIEWS.map((navItem) => (
            <button
              key={navItem}
              className={`main-nav-button nav-${stageSlug(navItem)} ${view === navItem ? "active-nav" : ""}`}
              onClick={() => {
                if (navItem === "Live" && !canSeeFullLive && isEmployeeMode) {
                  setView(employeeDepartment);
                  return;
                }

                setView(navItem);
              }}
            >
              {navItem}
            </button>
          ))}

          {currentRole === "Developer" && (
            <button
              className={`main-nav-button nav-dashboard ${view === "Dashboard" ? "active-nav" : ""}`}
              onClick={() => setView("Dashboard")}
            >
              Dashboard
            </button>
          )}
        </div>

        <div className="session-pill">
          <span>{currentUser?.displayName}</span>
          <b>{currentRole}</b>
        </div>

        {isEmployeeMode && (
          <select
            className="nav-select department-select"
            value={employeeDepartment}
            onChange={(e) => handleEmployeeDepartmentChange(e.target.value)}
          >
            {EMPLOYEE_DEPARTMENTS.map((department) => (
              <option key={department} value={department}>
                Department: {department}
              </option>
            ))}
          </select>
        )}

        {["Developer", "Admin"].includes(currentRole) && (
          <div className="nav-button-group backup-actions">
            <button className="dev-tool-button" onClick={() => fishbowlCsvInputRef.current?.click()}>
              Import Fishbowl Schedule
            </button>

            {currentRole === "Developer" && (
              <>
                <button className="dev-tool-button" onClick={exportBackup}>Export Full Backup</button>

                <button className="dev-tool-button" onClick={() => backupInputRef.current?.click()}>
                  Import Full Backup
                </button>
              </>
            )}
          </div>
        )}

        <input
          ref={fishbowlCsvInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={importFishbowlScheduleCsv}
        />

        <input
          ref={backupInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={importBackup}
        />
      </div>

      {!isEmployeeMode && view !== "Schedule" && (
        <div className="stats-row">
          <div className="stat-card">
            <span>Scheduled Jobs</span>
            <b>{dashboard.scheduledJobs}</b>
          </div>

          <div className="stat-card">
            <span>Scheduled Qty</span>
            <b>{dashboard.scheduledQty}</b>
          </div>

          <div className="stat-card">
            <span>Active Live Jobs</span>
            <b>{dashboard.activeJobs}</b>
          </div>

          <div className="stat-card">
            <span>Completed Qty</span>
            <b>{dashboard.completedQty}</b>
          </div>
        </div>
      )}

      <div
        className={
          view === "Models"
            ? selectedModel
              ? "layout mobile-model-open"
              : "layout"
            : "layout layout-full"
        }
      >
        {view === "Dashboard" && currentRole === "Developer" && <DevProductionDashboard />}

        {view === "Models" && (
          <aside className="sidebar">
          <h2>Collections</h2>

          {filteredModels.length === 0 && (
            <div className="empty small">No collections yet.</div>
          )}

          {filteredModels.map((model) => (
            <div
              key={model.id}
              className={
                selectedModelId === model.id
                  ? "side-card selected"
                  : "side-card"
              }
            >
              <button
                className="plain"
                onClick={() => {
                  setSelectedModelId(model.id);
                  setOpenTypeId(null);
                  setView("Models");
                }}
              >
                <b>{model.name}</b>
                <span>{model.types?.length || 0} furniture types</span>
              </button>

              {canDelete && (
                <button className="danger" onClick={() => deleteModel(model.id)}>
                  Delete
                </button>
              )}
            </div>
          ))}

          {canManage && (
            <div className="add-box">
              <input
                placeholder="New Collection"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
              />

              <button onClick={addModel}>Add Collection</button>
            </div>
          )}
        </aside>
        )}

        <main className="main">
          {view === "Models" && (
            <>
              {!selectedModel ? (
                <div className="hero">
                  <h1>Select or create a collection</h1>
                  <p>
                    Collections hold furniture pieces. Each furniture piece can
                    have a saved parts list, image, and schedule jobs.
                  </p>
                </div>
              ) : (
                <>
                  <div className="page-head">
                    <div>
                      <h1>{selectedModel.name}</h1>
                      <p className="muted">
                        Add furniture pieces, save parts, and schedule
                        production.
                      </p>
                    </div>
                  </div>

                  <button
                    className="mobile-back-button"
                    onClick={() => {
                      setSelectedModelId(null);
                      setOpenTypeId(null);
                    }}
                  >
                    ← Back To Collections
                  </button>

                  {canManage && (
                    <div className="card">
                      <h2>Add Furniture Type</h2>

                      <div className="form-grid">
                        <input
                          placeholder="Furniture Name"
                          value={typeName}
                          onChange={(e) => setTypeName(e.target.value)}
                        />

                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) =>
                            readImage(e.target.files[0], setTypeImage)
                          }
                        />
                      </div>

                      {typeImage && (
                        <img src={typeImage} className="preview" alt="" />
                      )}

                      <button onClick={addType}>Add Furniture</button>
                    </div>
                  )}

                  {selectedModelTypes.length === 0 && (
                    <div className="empty">
                      {hasSearch
                        ? "No furniture in this collection matches your search."
                        : "No furniture added to this collection yet."}
                    </div>
                  )}

                  {selectedModelTypes.map((type) => (
                    <div key={type.id} className="card furniture-card">
                      {editingTypeId === type.id ? (
                        <>
                          <h2>Edit Furniture</h2>

                          {editingTypeImage && (
                            <img
                              src={editingTypeImage}
                              className="preview"
                              alt=""
                            />
                          )}

                          <div className="form-grid">
                            <input
                              value={editingTypeName}
                              onChange={(e) =>
                                setEditingTypeName(e.target.value)
                              }
                            />

                            <input
                              type="file"
                              accept="image/*"
                              onChange={(e) =>
                                readImage(
                                  e.target.files[0],
                                  setEditingTypeImage
                                )
                              }
                            />
                          </div>

                          <div className="button-row">
                            <button onClick={saveEditType}>Save</button>
                            <button onClick={cancelEditType}>Cancel</button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="furniture-head">
                            {type.image && (
                              <img
                                src={type.image}
                                className="furniture-img"
                                alt=""
                              />
                            )}

                            <div>
                              <h2 className="furniture-title">{type.name}</h2>
                              <p className="muted">
                                {type.parts?.length || 0} saved parts
                              </p>

                              {(type.sku ||
                                type.dimensions ||
                                type.seatHeight ||
                                type.seatWidth ||
                                type.seatDepth ||
                                type.stackable ||
                                type.material ||
                                type.specs?.sku ||
                                type.specs?.dimensions ||
                                type.specs?.seatHeight ||
                                type.specs?.seatWidth ||
                                type.specs?.seatDepth ||
                                type.specs?.stackable ||
                                type.specs?.material) && (
                                <div className="info-grid model-spec-grid">
                                  {(type.sku || type.specs?.sku) && (
                                    <p className="model-sku-line"><b>SKU:</b> {type.sku || type.specs?.sku}</p>
                                  )}
                                  {(type.dimensions || type.specs?.dimensions) && (
                                    <p className="model-dimensions-line"><b>Dimensions:</b> {type.dimensions || type.specs?.dimensions}</p>
                                  )}
                                  {(type.seatHeight || type.specs?.seatHeight) && (
                                    <p><b>Seat Height:</b> {type.seatHeight || type.specs?.seatHeight}</p>
                                  )}
                                  {(type.seatWidth || type.specs?.seatWidth) && (
                                    <p><b>Seat Width:</b> {type.seatWidth || type.specs?.seatWidth}</p>
                                  )}
                                  {(type.seatDepth || type.specs?.seatDepth) && (
                                    <p><b>Seat Depth:</b> {type.seatDepth || type.specs?.seatDepth}</p>
                                  )}
                                  {(type.stackable || type.specs?.stackable) && (
                                    <p><b>Stackable:</b> {type.stackable || type.specs?.stackable}</p>
                                  )}
                                  {(type.material || type.specs?.material) && (
                                    <p><b>Material:</b> {type.material || type.specs?.material}</p>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="quick-schedule">
                            <span>Add to schedule:</span>

                            <select
                              value={scheduleForm.weekSlot}
                              onChange={(e) =>
                                setScheduleForm({
                                  ...scheduleForm,
                                  weekSlot: Number(e.target.value),
                                })
                              }
                            >
                              {scheduleWeeks.map((week, index) => (
                                <option key={index} value={index}>
                                  {week || `Week ${index + 1}`}
                                </option>
                              ))}
                            </select>

                            <button
                              onClick={() =>
                                setScheduleForm({
                                  ...scheduleForm,
                                  qty: Math.max(
                                    1,
                                    Number(scheduleForm.qty || 1) - 1
                                  ),
                                })
                              }
                            >
                              -
                            </button>

                            <input
                              type="number"
                              min="1"
                              value={scheduleForm.qty}
                              onChange={(e) =>
                                setScheduleForm({
                                  ...scheduleForm,
                                  qty: e.target.value,
                                })
                              }
                            />

                            <button
                              onClick={() =>
                                setScheduleForm({
                                  ...scheduleForm,
                                  qty: Number(scheduleForm.qty || 1) + 1,
                                })
                              }
                            >
                              +
                            </button>
                          </div>

                          <div className="button-row">
                            {canManage && (
                              <button onClick={() => addToSchedule(type)}>
                                Add To Schedule
                              </button>
                            )}

                            <button
                              onClick={() => setCutSheetView({ model: selectedModel, type })}
                            >
                              View Cut Sheet
                            </button>

                            {canManage && (
                              <button
                                onClick={() =>
                                  setOpenTypeId(
                                    openTypeId === type.id ? null : type.id
                                  )
                                }
                              >
                                {openTypeId === type.id
                                  ? "Close Parts Editor"
                                  : "Edit Parts"}
                              </button>
                            )}

                            {canPrint && (
                              <button onClick={() => printCutSheet(selectedModel, type)}>
                                Print Cut Sheet
                              </button>
                            )}

                            {canManage && (
                              <button onClick={() => cloneFurniture(type)}>
                                Clone Furniture
                              </button>
                            )}

                            {canDelete && (
                              <button
                                className="danger"
                                onClick={() => deleteType(type.id)}
                              >
                                Delete Furniture
                              </button>
                            )}
                          </div>
                        </>
                      )}

                      {openTypeId === type.id && editingTypeId !== type.id && (
                        <div className="parts-panel compact-parts-panel">
                          <div className="parts-panel-head">
                            <div>
                              <h2>{type.name} Parts</h2>
                              <p className="muted">
                                Compact cut list view for quick shop-floor review.
                              </p>
                            </div>

                            <div className="parts-summary">
                              <span>
                                <b>{type.parts?.length || 0}</b> Parts
                              </span>
                              <span>
                                <b>
                                  {(type.parts || []).reduce(
                                    (sum, part) => sum + Number(part.qty || 0),
                                    0
                                  )}
                                </b>{" "}
                                Total Qty
                              </span>
                            </div>
                          </div>

                          {type.parts?.length === 0 && (
                            <div className="empty small">
                              No parts saved yet.
                            </div>
                          )}

                          {type.parts?.length > 0 && (
                            <div className="compact-parts-table">
                              <div className="parts-header-row compact-header-row">
                                <span>Part</span>
                                <span>Material</span>
                                <span>Length</span>
                                <span>Qty</span>
                                <span>Angle</span>
                                <span>Actions</span>
                              </div>

                              {type.parts.map((part) => (
                                <div key={part.id} className="part-row compact-part-row">
                                  <span className="part-cell part-name-cell">
                                    <small>Part</small>
                                    <b>{part.name}</b>
                                  </span>

                                  <span className="part-cell">
                                    <small>Material</small>
                                    {part.tube || "-"}
                                  </span>

                                  <span className="part-cell">
                                    <small>Length</small>
                                    {part.length || "-"}
                                  </span>

                                  <span className="part-cell qty-cell">
                                    <small>Qty</small>
                                    <b>{part.qty || "-"}</b>
                                  </span>

                                  <span className="part-cell">
                                    <small>Angle</small>
                                    {part.angle || "-"}
                                  </span>

                                  {(canManage || canDelete) && (
                                    <div className="part-actions compact-actions">
                                      {canManage && (
                                        <button onClick={() => editPart(part)}>
                                          Edit
                                        </button>
                                      )}

                                      {canDelete && (
                                        <button
                                          className="danger"
                                          onClick={() => deletePart(type.id, part.id)}
                                        >
                                          Delete
                                        </button>
                                      )}
                                    </div>
                                  )}

                                  {part.notes && (
                                    <div className="part-note compact-part-note">
                                      <b>Notes:</b> {part.notes}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="add-parts-area">
                            <h3>{editingPartId ? "Edit Part" : "Add New Part"}</h3>

                            <div className="form-grid">
                              <input
                                placeholder="Part Name"
                                value={partForm.name}
                                onChange={(e) =>
                                  setPartForm({
                                    ...partForm,
                                    name: e.target.value,
                                  })
                                }
                              />

                              <input
                                placeholder="Material Size"
                                value={partForm.tube}
                                onChange={(e) =>
                                  setPartForm({
                                    ...partForm,
                                    tube: e.target.value,
                                  })
                                }
                              />

                              <input
                                placeholder="Length"
                                value={partForm.length}
                                onChange={(e) =>
                                  setPartForm({
                                    ...partForm,
                                    length: e.target.value,
                                  })
                                }
                              />

                              <input
                                placeholder="Qty"
                                value={partForm.qty}
                                onChange={(e) =>
                                  setPartForm({
                                    ...partForm,
                                    qty: e.target.value,
                                  })
                                }
                              />

                              <input
                                placeholder="Angle"
                                value={partForm.angle}
                                onChange={(e) =>
                                  setPartForm({
                                    ...partForm,
                                    angle: e.target.value,
                                  })
                                }
                              />

                              <input
                                placeholder="Notes"
                                value={partForm.notes}
                                onChange={(e) =>
                                  setPartForm({
                                    ...partForm,
                                    notes: e.target.value,
                                  })
                                }
                              />
                            </div>

                            <div className="button-row">
                              <button onClick={() => addOrUpdatePart(type.id)}>
                                {editingPartId ? "Update Part" : "Add Part"}
                              </button>

                              {editingPartId && (
                                <button onClick={cancelEditPart}>
                                  Cancel Edit
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          )}

          {view === "Messages" && (
            <>
              <div className="page-head messages-page-head">
                <div>
                  <h1>Shop Notes</h1>
                  <p className="muted">
                    Send quick shop-floor messages that update live for everyone signed in.
                  </p>
                </div>
              </div>

              <section className="messages-layout">
                <form className="card message-compose-card" onSubmit={sendShopMessage}>
                  <h2>New Message</h2>

                  <div className="message-route-grid">
                    <div>
                      <label>From</label>
                      <div className="message-route-pill">{getShopMessageFromLabel()}</div>
                    </div>

                    <div>
                      <label>To</label>
                      <select
                        value={shopMessageTo}
                        onChange={(e) => setShopMessageTo(e.target.value)}
                      >
                        {MESSAGE_RECIPIENTS.map((recipient) => (
                          <option key={recipient} value={recipient}>
                            {recipient}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <label>Message</label>
                  <textarea
                    className="message-textarea"
                    value={shopMessageText}
                    onChange={(e) => setShopMessageText(e.target.value)}
                    placeholder="Example: Braden, we are short 2 legs for Destin arm chairs."
                    rows="4"
                  />

                  <div className="message-photo-actions">
                    <button type="button" className="secondary" onClick={() => messagePhotoInputRef.current?.click()}>
                      Attach Photo
                    </button>

                    {shopMessagePhoto && (
                      <button type="button" className="danger" onClick={clearShopMessagePhoto}>
                        Remove Photo
                      </button>
                    )}
                  </div>

                  <input
                    ref={messagePhotoInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={handleShopMessagePhoto}
                  />

                  {shopMessagePhoto && (
                    <div className="message-photo-preview">
                      <img src={shopMessagePhoto} alt="Message attachment preview" />
                      <span>{shopMessagePhotoName || "Attached photo"}</span>
                    </div>
                  )}

                  <button className="wide message-send-button" type="submit">
                    Send Message
                  </button>
                </form>

                <section className="card message-feed-card">
                  <div className="message-feed-head">
                    <h2>Recent Shop Notes</h2>
                    <span>{shopMessages.length} shown</span>
                  </div>

                  {shopMessages.length === 0 ? (
                    <div className="empty">No shop notes yet.</div>
                  ) : (
                    <div className="message-list">
                      {shopMessages.map((message) => (
                        <article key={message.id} className="shop-message-card">
                          <div className="shop-message-topline">
                            <div>
                              <b>{message.sender_role || "Team"} → {message.department || "Everyone"}</b>
                              <span>{message.sender_name || "Team Member"} • {formatMessageTime(message.created_at)}</span>
                            </div>

                            <span className="message-department-badge">
                              To: {message.department || "Everyone"}
                            </span>
                          </div>

                          <p>{message.message}</p>

                          {message.attachment_url && (
                            <a
                              className="message-photo-link"
                              href={message.attachment_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <img src={message.attachment_url} alt={message.attachment_name || "Shop note attachment"} />
                            </a>
                          )}

                          <div className="message-ack-row">
                            <button
                              type="button"
                              className={hasAcknowledgedMessage(message) ? "message-ack-button acknowledged" : "message-ack-button"}
                              onClick={() => toggleShopMessageAck(message)}
                            >
                              👍 {Array.isArray(message.acknowledgements) ? message.acknowledgements.length : 0}
                            </button>

                            {Array.isArray(message.acknowledgements) && message.acknowledgements.length > 0 && (
                              <span className="message-ack-names">
                                {message.acknowledgements.map((ack) => ack.name || ack.department || "Team").join(", ")}
                              </span>
                            )}
                          </div>

                          {(canDelete || currentRole === "Admin") && (
                            <button
                              className="danger message-delete-button"
                              onClick={() => deleteShopMessage(message.id)}
                            >
                              Delete
                            </button>
                          )}
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </section>
            </>
          )}

          {view === "Schedule" && (
            (() => {
              const safeSelectedWeek = Math.min(
                scheduleWeeks.length - 1,
                Math.max(0, selectedScheduleWeek)
              );

              const selectedWeekName =
                scheduleWeeks[safeSelectedWeek] || `Week ${safeSelectedWeek + 1}`;

              const selectedWeekJobs = filteredSchedule.filter(
                (job) => getJobWeekSlot(job) === safeSelectedWeek
              );

              const activeJobs = selectedWeekJobs.filter(
                (job) => job.status !== "Complete"
              );

              const completedJobs = selectedWeekJobs.filter(
                (job) => job.status === "Complete"
              );

              const activeQty = activeJobs.reduce(
                (sum, job) => sum + Number(job.qtyNeeded || 0),
                0
              );

              const remainingQty = activeJobs.reduce(
                (sum, job) =>
                  sum +
                  Math.max(
                    0,
                    Number(job.qtyNeeded || 0) - Number(job.qtyComplete || 0)
                  ),
                0
              );

              return (
                <>
                  <div className="page-head schedule-page-head">
                    <div>
                      <h1>Weekly Production Schedule</h1>
                      <p className="muted">
                        Select one week at a time for a cleaner monitor-style view.
                      </p>
                      {fishbowlImportSummary && (
                        <p className="note">{fishbowlImportSummary}</p>
                      )}
                    </div>
                  </div>

                  <div className="schedule-week-tabs">
                    {scheduleWeeks.map((week, index) => {
                      const weekJobs = filteredSchedule.filter(
                        (job) => getJobWeekSlot(job) === index
                      );
                      const weekActive = weekJobs.filter(
                        (job) => job.status !== "Complete"
                      ).length;
                      const weekComplete = weekJobs.filter(
                        (job) => job.status === "Complete"
                      ).length;

                      return (
                        <button
                          key={index}
                          className={
                            safeSelectedWeek === index
                              ? "schedule-week-tab active-schedule-week"
                              : "schedule-week-tab"
                          }
                          onClick={() => setSelectedScheduleWeek(index)}
                        >
                          <b>{week || `Week ${index + 1}`}</b>
                          <span>{weekActive} active / {weekComplete} complete</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="schedule-full-panel">
                    <div className="schedule-selected-head">
                      <div>
                        <label>Week Of</label>
                        <input
                          className="week-title-input schedule-selected-input"
                          value={selectedWeekName}
                          placeholder="Example: 5/13/26"
                          onChange={(e) =>
                            updateScheduleWeekName(safeSelectedWeek, e.target.value)
                          }
                        />
                      </div>

                      {!isEmployeeMode && (
                        <div className="schedule-head-stats">
                          <div>
                            <span>Active Jobs</span>
                            <b>{activeJobs.length}</b>
                          </div>
                          <div>
                            <span>Scheduled Qty</span>
                            <b>{activeQty}</b>
                          </div>
                          <div>
                            <span>Remaining Qty</span>
                            <b>{remainingQty}</b>
                          </div>
                          <div>
                            <span>Complete</span>
                            <b>{completedJobs.length}</b>
                          </div>
                        </div>
                      )}
                    </div>

                    {activeJobs.length === 0 ? (
                      <div className="empty">No active scheduled jobs for this week.</div>
                    ) : (
                      <div className="schedule-active-grid">
                        {activeJobs.map((job) => {
                          const remaining = job.qtyNeeded - job.qtyComplete;
                          const jobSku = job.sku || job.specs?.sku;

                          return (
                            <div
                              key={job.id}
                              className={
                                job.status === "In Production"
                                  ? "schedule-board-card schedule-board-card-production"
                                  : "schedule-board-card"
                              }
                            >
                              <div className="schedule-board-main">
                                {job.image && (
                                  <img
                                    src={job.image}
                                    className="schedule-board-img"
                                    alt=""
                                  />
                                )}

                                <div className="schedule-board-title">
                                  <h3 className={job.furniture.length > 30 ? "schedule-title-long" : ""}>{job.furniture}</h3>
                                  {jobSku && <span className={String(jobSku).length > 18 ? "schedule-sku-long" : ""}>SKU: {jobSku}</span>}
                                </div>
                              </div>

                              <div className="schedule-board-side">
                                <div className="schedule-board-qty">
                                  <b>Qty:</b>
                                  <button onClick={() => adjustScheduleQty(job.id, -1)}>
                                    -
                                  </button>
                                  <span>{job.qtyNeeded}</span>
                                  <button onClick={() => adjustScheduleQty(job.id, 1)}>
                                    +
                                  </button>
                                </div>

                                <div className="schedule-board-status">
                                  <span><b>Remaining:</b> {remaining}</span>
                                  <span>{job.status}</span>
                                </div>

                                <div className="schedule-board-actions">
                                  {!isEmployeeMode && (
                                    <button onClick={() => toggleScheduleComplete(job.id)}>
                                      Check Off
                                    </button>
                                  )}

                                  <button
                                    onClick={() =>
                                      setCutSheetView({
                                        model: { name: job.collection },
                                        type: {
                                          ...job,
                                          name: job.furniture,
                                          image: job.image,
                                          parts: job.partsSnapshot || [],
                                        },
                                      })
                                    }
                                  >
                                    View Cut Sheet
                                  </button>

                                  {canManage && (
                                    <button onClick={() => releaseToProduction(job)}>
                                      Release To Live
                                    </button>
                                  )}

                                  {canPrint && (
                                    <button
                                      onClick={() =>
                                        printCutSheet(
                                          { name: job.collection },
                                          {
                                            ...job,
                                            name: job.furniture,
                                            image: job.image,
                                            parts: job.partsSnapshot || [],
                                          }
                                        )
                                      }
                                    >
                                      Print Cut Sheet
                                    </button>
                                  )}

                                  {canManage && (
                                    <button onClick={() => duplicateScheduledJob(job)}>
                                      Duplicate
                                    </button>
                                  )}

                                  {canDelete && (
                                    <button
                                      className="danger"
                                      onClick={() => removeScheduledJob(job.id)}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {completedJobs.length > 0 && (
                      <details className="completed-schedule-group schedule-completed-panel">
                        <summary>Completed this week ({completedJobs.length})</summary>

                        {(["Developer", "Supervisor"].includes(currentRole)) && (
                          <div className="completed-schedule-tools">
                            <button
                              className="danger"
                              onClick={() => clearCompletedScheduleForWeek(safeSelectedWeek)}
                            >
                              Remove Completed This Week
                            </button>
                          </div>
                        )}

                        <div className="completed-schedule-grid">
                          {completedJobs.map((job) => (
                            <div key={job.id} className="completed-schedule-row">
                              <span>{job.furniture}</span>
                              {(job.sku || job.specs?.sku) && (
                                <b>{job.sku || job.specs?.sku}</b>
                              )}
                              {!isEmployeeMode && (
                                <button onClick={() => toggleScheduleComplete(job.id)}>
                                  Undo
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                </>
              );
            })()
          )}

          {view === "Live" && (
            (() => {
              const liveDepartments = STAGES;
              const activeLiveTab = liveDepartments.includes(liveOverviewTab)
                ? liveOverviewTab
                : "Fabrication";

              const overviewPanels = fullLivePanelsForView(activeLiveTab);

              return (
                <>
                  <div className="page-head">
                    <div>
                      <h1>{isAdminLiveOverview ? "Live Production Overview" : "Live Shop Mode"}</h1>
                      <p className="muted">
                        {isAdminLiveOverview
                          ? currentRole === "Admin"
                            ? "Read-only monitor view. Use department buttons to reduce scrolling."
                            : "Supervisor view. Use department buttons to focus on one area at a time."
                          : "This is what is actively moving through the shop right now."}
                      </p>
                    </div>

                    {elevatedModes.includes(currentRole) && (
                      <button onClick={clearCompletedLiveJobs}>
                        Remove Completed Jobs
                      </button>
                    )}
                  </div>

                  {canSeeFullLive && (
                    <div className="department-view-tabs live-overview-tabs">
                      {liveDepartments.map((department) => {
                        const departmentIndex = STAGES.indexOf(department);
                        const count = liveForStage(departmentIndex).length;

                        return (
                          <button
                            key={department}
                            className={
                              activeLiveTab === department
                                ? "department-view-tab active-department-view-tab"
                                : "department-view-tab"
                            }
                            onClick={() => setLiveOverviewTab(department)}
                          >
                            <b>{department}</b>
                            <span>{count} jobs</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {canSeeFullLive ? (
                    <div className="stage-list department-stage-list live-focused-view">
                      {overviewPanels.map((panel) => (
                        <section
                          key={panel.title}
                          className={`department-stage-panel stage-column stage-${stageSlug(panel.stageName)}`}
                        >
                          <h2>{panel.title}</h2>

                          {panel.jobs.length === 0 ? (
                            <div className="empty small">No active jobs in {panel.title}.</div>
                          ) : (
                            <div className="department-job-grid">
                              {panel.jobs.map((job) => (
                                <JobCard key={job.id} job={job} />
                              ))}
                            </div>
                          )}
                        </section>
                      ))}
                    </div>
                  ) : (
                    <div className="kanban">
                      {STAGES.map((stage, index) => (
                        <div key={stage} className={`kanban-column stage-column stage-${stageSlug(stage)}`}>
                          <h2>{stage}</h2>

                          {liveForStage(index).length === 0 && (
                            <div className="empty small">No jobs here.</div>
                          )}

                          {liveForStage(index).map((job) => (
                            <JobCard key={job.id} job={job} />
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()
          )}

          {STAGES.includes(view) && (
            (() => {
              const panels = departmentPanelsForView(view);
              const employeeActivePanel =
                panels.find((panel) => panel.title === employeePanelTab) ||
                panels.find((panel) => panel.title === view) ||
                panels[0];

              return (
                <>
                  <div className="page-head department-page-head">
                    <div>
                      <h1>{view} Dashboard</h1>
                      <p className="muted">
                        {view === "Fabrication"
                          ? "Fabrication jobs currently ready for the fabrication team."
                          : isEmployeeMode
                          ? `Use the tabs to view ${view} and nearby work without side scrolling.`
                          : `Showing ${STAGES[STAGES.indexOf(view) - 1]} and ${view}, so the team can see what is coming next.`}
                      </p>
                    </div>
                  </div>

                  {isEmployeeMode && panels.length > 1 && (
                    <div className="department-view-tabs">
                      {panels.map((panel) => (
                        <button
                          key={panel.title}
                          className={
                            employeeActivePanel?.title === panel.title
                              ? "department-view-tab active-department-view-tab"
                              : "department-view-tab"
                          }
                          onClick={() => setEmployeePanelTab(panel.title)}
                        >
                          <b>{panel.title}</b>
                          <span>{panel.jobs.length} jobs</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {isEmployeeMode ? (
                    <div className="stage-list department-stage-list single-department-stage-list">
                      <section
                        className={`department-stage-panel single-department-panel stage-column stage-${stageSlug(employeeActivePanel?.stageName)}`}
                      >
                        <h2>{employeeActivePanel?.title}</h2>

                        {!employeeActivePanel || employeeActivePanel.jobs.length === 0 ? (
                          <div className="empty small">No active jobs here.</div>
                        ) : (
                          <div className="department-job-grid">
                            {employeeActivePanel.jobs.map((job) => (
                              <JobCard key={job.id} job={job} />
                            ))}
                          </div>
                        )}
                      </section>
                    </div>
                  ) : (
                    <div className="stage-list department-stage-list">
                      {panels.map((panel) => {
                        return (
                          <section
                            key={panel.title}
                            className={`department-stage-panel stage-column stage-${stageSlug(panel.stageName)}`}
                          >
                            <h2>{panel.title}</h2>

                            {panel.jobs.length === 0 ? (
                              <div className="empty small">No active jobs in {panel.title}.</div>
                            ) : (
                              <div className="department-job-grid">
                                {panel.jobs.map((job) => (
                                  <JobCard key={job.id} job={job} />
                                ))}
                              </div>
                            )}
                          </section>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()
          )}
        </main>
      </div>

      <div className="bottom-logout-wrap">
        <button className="logout-button" onClick={handleLogout}>
          Log Out
        </button>
      </div>

      {cutSheetView && (
        <div className="cut-sheet-modal-backdrop" onClick={() => setCutSheetView(null)}>
          <div className="cut-sheet-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cut-sheet-modal-actions">
              <button onClick={() => setCutSheetView(null)}>Close</button>
              <button
                onClick={() =>
                  printCutSheet(cutSheetView.model, cutSheetView.type)
                }
              >
                Download PDF
              </button>
            </div>

            <div className="cut-sheet-preview">
              <div className="cut-sheet-preview-header">
                <div>
                  <div className="cut-sheet-logo">ADMIRAL</div>
                  <div className="cut-sheet-logo-sub">OUTDOOR</div>
                  <h1>{cutSheetView.type.name}</h1>
                  <h2>{cutSheetView.model.name}</h2>
                  <div className="cut-sheet-meta">
                    <div><b>Total Parts:</b> {cutSheetView.type.parts?.length || 0}</div>
                    <div><b>Generated:</b> {new Date().toLocaleDateString()}</div>
                  </div>
                </div>

                {cutSheetView.type.image && (
                  <img
                    src={cutSheetView.type.image}
                    className="cut-sheet-preview-img"
                    alt=""
                  />
                )}
              </div>

              {(() => {
                const specs = getItemSpecs(cutSheetView.type);
                const specRows = [
                  ["SKU", specs.sku],
                  ["Dimensions", specs.dimensions],
                  ["Seat Height", specs.seatHeight],
                  ["Seat Width", specs.seatWidth],
                  ["Seat Depth", specs.seatDepth],
                  ["Stackable", specs.stackable],
                  ["Material", specs.material],
                ].filter(([, value]) => value);

                return specRows.length > 0 ? (
                  <div className="cut-sheet-spec-box">
                    {specRows.map(([label, value]) => (
                      <div key={label} className={label === "SKU" ? "sku-line" : ""}>
                        <b>{label}:</b> {value}
                      </div>
                    ))}
                  </div>
                ) : null;
              })()}

              <div className="cut-sheet-table-wrap">
                <table className="cut-sheet-table">
                  <thead>
                    <tr>
                      <th>Part</th>
                      <th>Material</th>
                      <th>Length</th>
                      <th>Qty</th>
                      <th>Angle</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(cutSheetView.type.parts || []).length > 0 ? (
                      cutSheetView.type.parts.map((part) => (
                        <tr key={part.id || part.name}>
                          <td>{part.name || ""}</td>
                          <td>{part.tube || ""}</td>
                          <td>{part.length || ""}</td>
                          <td>{part.qty || ""}</td>
                          <td>{part.angle || ""}</td>
                          <td>{part.notes || ""}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="6">No parts saved yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;