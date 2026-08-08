import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { supabase } from "./supabaseClient";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Boxes,
  CalendarDays,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Database,
  Eye,
  LayoutDashboard,
  MessageSquare,
  Package,
  Package2,
  PackageCheck,
  PaintBucket,
  Pencil,
  Plus,
  PlusCircle,
  Recycle,
  RotateCcw,
  ScanSearch,
  Scissors,
  Trash2,
  TriangleAlert,
  Truck,
  Wrench,
  Clock3,
} from "lucide-react";
import {
  MATERIAL_OPTIMIZER_DEFAULT_KERF,
  MATERIAL_OPTIMIZER_MODES,
  MATERIAL_OPTIMIZER_REUSABLE_DROP,
  buildMaterialOptimizerPlan,
  formatOptimizerInches,
} from "./utils/materialOptimizer";
import {
  getSharedAppDataHash,
  isValidCloudAppData,
  normalizeSharedAppData,
  resolveInitialSharedAppData,
  shouldPersistSharedAppData,
} from "./utils/sharedAppDataSync";

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

const PRIMARY_VIEWS = ["Models", "Schedule", "Live", "Messages", "Dashboard"];
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
  notes: ["notes", "note", "memo", "customer", "customer name", "sales order", "so", "order", "order number", "work order", "wo", "job", "job number", "job no", "promise date", "priority", "ship method"],
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

function secureAdmiralImageUrl(value) {
  if (typeof value !== "string") return value;

  return value.replace(
    /^http:\/\/admiral-outdoor\.com(?=\/)/i,
    "https://admiral-outdoor.com"
  );
}

function secureImageItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    const secureImage = secureAdmiralImageUrl(item?.image);
    return secureImage === item?.image ? item : { ...item, image: secureImage };
  });
}

function secureModelImages(models) {
  return (Array.isArray(models) ? models : []).map((model) => {
    const secureTypes = secureImageItems(model?.types);
    const imagesChanged = secureTypes.some(
      (type, index) => type !== model?.types?.[index]
    );

    return imagesChanged ? { ...model, types: secureTypes } : model;
  });
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

function writeLocalAppData(nextData) {
  localStorage.setItem("models", JSON.stringify(nextData.models || []));
  localStorage.setItem("schedule", JSON.stringify(nextData.schedule || []));
  localStorage.setItem("liveJobs", JSON.stringify(nextData.liveJobs || []));
  localStorage.setItem(
    "rawStockInventory",
    JSON.stringify(nextData.rawStockInventory || [])
  );
  localStorage.setItem(
    "reusableDropInventory",
    JSON.stringify(nextData.reusableDropInventory || [])
  );
  localStorage.setItem(
    "scheduleWeeks",
    JSON.stringify(nextData.scheduleWeeks || DEFAULT_SCHEDULE_WEEKS)
  );
}

function createSharedAppDataPayload(nextData, activeUser, clientId) {
  const normalizedData = normalizeSharedAppData(
    nextData,
    DEFAULT_SCHEDULE_WEEKS
  );

  return {
    ...normalizedData,
    savedAt: new Date().toISOString(),
    savedByClientId: clientId,
    savedByUser: activeUser
      ? {
          id: activeUser.id || null,
          email: activeUser.email || null,
          username: activeUser.username || null,
          displayName: activeUser.displayName || null,
          role: activeUser.role || null,
        }
      : null,
  };
}

function formatGeneratedDate(value) {
  if (!value) return "Not available";

  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString()
    : "Not available";
}

const emptyPartForm = {
  name: "",
  tube: "",
  length: "",
  qty: "",
  angle: "",
  notes: "",
};

const emptyRawStockForm = {
  materialType: "",
  stockLength: "240",
  quantityOnHand: "",
  notes: "",
};

const emptyReusableDropForm = {
  materialType: "",
  length: "",
  createdDate: "",
  status: "Available",
  sourcePlanId: "",
  notes: "",
};

const REUSABLE_DROP_STATUSES = ["Available", "Reserved", "Used", "Scrapped"];

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

function getScheduleJobKey(job) {
  return String(
    job?.id ||
      job?.scheduleId ||
      job?.workOrder ||
      job?.workOrderNumber ||
      job?.orderNumber ||
      [
        job?.weekSlot ?? job?.week ?? "",
        job?.collection || "",
        job?.furniture || "",
        job?.sku || job?.specs?.sku || "",
        job?.createdAt || job?.dueDate || "",
      ].join("|")
  );
}

function getWeekJobMetrics(schedule, activeLiveJobs, selectedWeek) {
  const weekIndex = Number(selectedWeek || 0);
  const uniqueJobs = new Map();

  (Array.isArray(schedule) ? schedule : []).forEach((job) => {
    const jobWeek =
      typeof job?.weekSlot === "number"
        ? job.weekSlot
        : getLegacyWeekSlot(job?.week);

    if (jobWeek !== weekIndex) return;

    const key = getScheduleJobKey(job);
    if (!uniqueJobs.has(key)) uniqueJobs.set(key, job);
  });

  const jobs = Array.from(uniqueJobs.values());
  const liveScheduleIds = new Set(
    (Array.isArray(activeLiveJobs) ? activeLiveJobs : [])
      .map((job) => job?.scheduleId)
      .filter(Boolean)
      .map(String)
  );
  const isComplete = (job) => {
    const total = Math.max(0, Number(job?.qtyNeeded || 0));
    const completed = Math.max(0, Number(job?.qtyComplete || 0));
    return job?.status === "Complete" || (total > 0 && completed >= total);
  };
  const completedJobs = jobs.filter(isComplete);
  const activeJobs = jobs.filter(
    (job) =>
      !isComplete(job) &&
      (job?.status === "In Production" ||
        liveScheduleIds.has(getScheduleJobKey(job)))
  );
  const delayedJobs = jobs.filter((job) => {
    if (isComplete(job)) return false;
    const text = `${job?.status || ""} ${job?.notes || ""}`.toLowerCase();
    return text.includes("delay") || text.includes("late") || text.includes("hold");
  });

  return {
    jobs,
    scheduledJobs: jobs.length,
    activeJobs: activeJobs.length,
    completedJobs: completedJobs.length,
    delayedJobs: delayedJobs.length,
    remainingJobs: Math.max(0, jobs.length - completedJobs.length),
  };
}

function getDashboardJobProgress(job) {
  const total = Math.max(0, Number(job?.qty || 0));
  const rawCompleted =
    Number(job?.stage || 0) === 0
      ? job?.partsReady
        ? total
        : 0
      : Number(job?.stageCompleteQty || 0);
  const completed = Math.min(total, Math.max(0, rawCompleted));
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { completed, total, percent };
}

function getMessageSenderLabel(message) {
  const senderName = String(message?.sender_name || "").trim();
  const senderRole = String(message?.sender_role || "").trim();
  const departmentSender = EMPLOYEE_DEPARTMENTS.find(
    (department) => department.toLowerCase() === senderRole.toLowerCase()
  );

  if (departmentSender && senderName) return `${departmentSender} (${senderName})`;
  return senderName || senderRole || "Unknown";
}

function getMessageRecipientLabel(message) {
  return message?.department || "Everyone";
}

function stageSlug(stage) {
  return String(stage || "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}


function AnimatedNumber({ value, duration = 650 }) {
  const safeValue = Number(value || 0);
  const [displayValue, setDisplayValue] = useState(safeValue);
  const previousValueRef = useRef(safeValue);

  useEffect(() => {
    const startValue = previousValueRef.current;
    const endValue = safeValue;

    if (startValue === endValue) {
      setDisplayValue(endValue);
      return;
    }

    let frameId;
    const startedAt = performance.now();

    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = Math.round(startValue + (endValue - startValue) * eased);

      setDisplayValue(nextValue);

      if (progress < 1) {
        frameId = requestAnimationFrame(tick);
      } else {
        previousValueRef.current = endValue;
        setDisplayValue(endValue);
      }
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, [safeValue, duration]);

  return <>{displayValue}</>;
}

function LiveDashboardClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const todayLabel = now.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const timeLabel = now.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div className="tv-dashboard-clock">
      <b>{timeLabel}</b>
      <span>{todayLabel}</span>
    </div>
  );
}

function App() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.has("logout")) {
      url.searchParams.delete("logout");
      const nextUrl = `${url.pathname}${url.search}${url.hash}`;
      window.history.replaceState({}, "", nextUrl || "/");
    }
  }, []);

  const [view, setView] = useState("Models");
  const [search, setSearch] = useState("");

  const [models, setModels] = useState(() => {
    return secureModelImages(JSON.parse(localStorage.getItem("models")) || []);
  });

  const [schedule, setSchedule] = useState(() => {
    return secureImageItems(JSON.parse(localStorage.getItem("schedule")) || []);
  });

  const [liveJobs, setLiveJobs] = useState(() => {
    return secureImageItems(JSON.parse(localStorage.getItem("liveJobs")) || []);
  });

  const [rawStockInventory, setRawStockInventory] = useState(() => {
    return JSON.parse(localStorage.getItem("rawStockInventory")) || [];
  });

  const [reusableDropInventory, setReusableDropInventory] = useState(() => {
    return JSON.parse(localStorage.getItem("reusableDropInventory")) || [];
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
  const [rawStockForm, setRawStockForm] = useState(emptyRawStockForm);
  const [editingRawStockId, setEditingRawStockId] = useState(null);
  const [reusableDropForm, setReusableDropForm] = useState(emptyReusableDropForm);
  const [editingReusableDropId, setEditingReusableDropId] = useState(null);

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
  const currentUserRef = useRef(null);
  const cloudLoadRequestIdRef = useRef(0);
  const lastCloudDataHashRef = useRef("");
  const shopMessageDeleteInFlightRef = useRef(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [cloudDataLoaded, setCloudDataLoaded] = useState(false);
  const [loginForm, setLoginForm] = useState({ username: "", password: "" });
  const [loginError, setLoginError] = useState("");
  const [fishbowlImportSummary, setFishbowlImportSummary] = useState("");
  const [fishbowlSettings, setFishbowlSettings] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("fishbowlConnectionSettings")) || {
        serverUrl: "",
        apiPort: "",
        databaseName: "",
        username: "",
        syncMode: "Manual CSV Import",
        lastTestedAt: "",
      };
    } catch {
      return {
        serverUrl: "",
        apiPort: "",
        databaseName: "",
        username: "",
        syncMode: "Manual CSV Import",
        lastTestedAt: "",
      };
    }
  });
  const [fishbowlConnectionNote, setFishbowlConnectionNote] = useState("");
  const [shopMessages, setShopMessages] = useState([]);
  const [shopMessageText, setShopMessageText] = useState("");
  const [shopMessageTo, setShopMessageTo] = useState("Everyone");
  const [shopMessagePhoto, setShopMessagePhoto] = useState(null);
  const [shopMessagePhotoName, setShopMessagePhotoName] = useState("");
  const [shopMessageSending, setShopMessageSending] = useState(false);
  const [shopMessageDeletingId, setShopMessageDeletingId] = useState(null);
  const [shopMessageDeleteError, setShopMessageDeleteError] = useState("");
  const [selectedShopMessageAttachment, setSelectedShopMessageAttachment] = useState(null);
  const currentRole = currentUser?.role || "Employee";

  const [employeeDepartment, setEmployeeDepartment] = useState(() => {
    const savedDepartment = localStorage.getItem("employeeDepartment");
    const savedRole = localStorage.getItem("currentRole");

    // Only restore a department when the remembered role was actually Employee.
    // Developer/Admin/Supervisor should not carry an Employee department in storage.
    if (savedRole === "Employee" && EMPLOYEE_DEPARTMENTS.includes(savedDepartment)) {
      return savedDepartment;
    }

    return "Fabrication";
  });

  const [cutSheetView, setCutSheetView] = useState(null);
  const [selectedScheduleWeek, setSelectedScheduleWeek] = useState(0);
  const [materialOptimizerMode, setMaterialOptimizerMode] = useState("balanced");
  const [materialOptimizerSource, setMaterialOptimizerSource] = useState("currentWeek");
  const [reusableDropThreshold, setReusableDropThreshold] = useState(MATERIAL_OPTIMIZER_REUSABLE_DROP);
  const [optimizerKerf, setOptimizerKerf] = useState(MATERIAL_OPTIMIZER_DEFAULT_KERF);
  const [materialCutPlan, setMaterialCutPlan] = useState(null);
  const [expandedOptimizerPieces, setExpandedOptimizerPieces] = useState({});
  const [scheduleCutPlanOpen, setScheduleCutPlanOpen] = useState(false);
  const [employeePanelTab, setEmployeePanelTab] = useState(employeeDepartment);
  const [liveOverviewTab, setLiveOverviewTab] = useState("Fabrication");
  const [dashboardDepartment, setDashboardDepartment] = useState("Fabrication");
  const [recentlyMovedJobIds, setRecentlyMovedJobIds] = useState([]);
  const previousLiveJobStagesRef = useRef({});
  const hasTrackedLiveStagesRef = useRef(false);

  const resetLocalSessionState = useCallback(() => {
    cloudLoadRequestIdRef.current += 1;
    cloudReadyRef.current = false;
    lastCloudDataHashRef.current = "";
    currentUserRef.current = null;
    if (cloudSaveTimerRef.current) {
      clearTimeout(cloudSaveTimerRef.current);
      cloudSaveTimerRef.current = null;
    }
    setCloudDataLoaded(false);
    setCurrentUser(null);
    setLoginForm({ username: "", password: "" });
    setLoginError("");
    setEmployeeDepartment("Fabrication");
    setEmployeePanelTab("Fabrication");
    setDashboardDepartment("Fabrication");
    setShopMessageTo("Everyone");
    setView("Models");
  }, []);

  const applyAppData = useCallback((nextData) => {
    const normalizedData = normalizeSharedAppData(
      nextData,
      DEFAULT_SCHEDULE_WEEKS
    );
    const nextModels = secureModelImages(normalizedData.models);
    const nextSchedule = secureImageItems(normalizedData.schedule);
    const nextLiveJobs = secureImageItems(normalizedData.liveJobs);
    const nextRawStockInventory = normalizedData.rawStockInventory;
    const nextReusableDropInventory = normalizedData.reusableDropInventory;
    const nextScheduleWeeks = normalizedData.scheduleWeeks;
    const appliedData = {
      models: nextModels,
      schedule: nextSchedule,
      liveJobs: nextLiveJobs,
      rawStockInventory: nextRawStockInventory,
      reusableDropInventory: nextReusableDropInventory,
      scheduleWeeks: nextScheduleWeeks,
    };

    setModels(nextModels);
    setSchedule(nextSchedule);
    setLiveJobs(nextLiveJobs);
    setRawStockInventory(nextRawStockInventory);
    setReusableDropInventory(nextReusableDropInventory);
    setScheduleWeeks(nextScheduleWeeks);
    writeLocalAppData(appliedData);

    return appliedData;
  }, []);

  const createAppDataSnapshot = useCallback(async (payload, reason = "auto-save") => {
    const activeUser = currentUserRef.current;
    if (!activeUser) return false;

    const snapshotHash = JSON.stringify(payload);
    const now = Date.now();
    const shouldSkipSnapshot =
      reason === "auto-save" &&
      (snapshotHash === lastSnapshotHashRef.current ||
        now - lastSnapshotAtRef.current < SNAPSHOT_INTERVAL_MS);

    if (shouldSkipSnapshot) return true;

    const snapshotRecord = {
      appDataId: APP_DATA_ID,
      reason,
      savedAt: payload.savedAt,
      savedBy: {
        id: activeUser.id || null,
        email: activeUser.email || null,
        username: activeUser.username || null,
        displayName: activeUser.displayName || null,
        role: activeUser.role || null,
      },
      counts: {
        models: payload.models.length,
        schedule: payload.schedule.length,
        liveJobs: payload.liveJobs.length,
        rawStockInventory: payload.rawStockInventory?.length || 0,
        reusableDropInventory: payload.reusableDropInventory?.length || 0,
        scheduleWeeks: payload.scheduleWeeks.length,
      },
      data: payload,
    };

    try {
      const { error } = await supabase
        .from("app_data_snapshots")
        .insert({ data: snapshotRecord });

      if (error) {
        console.warn("Snapshot save failed, but main cloud save is still safe:", error);
        return false;
      }
    } catch (error) {
      console.warn(
        "Snapshot save failed before Supabase returned a response, but main cloud save is still safe:",
        error
      );
      return false;
    }

    lastSnapshotAtRef.current = now;
    lastSnapshotHashRef.current = snapshotHash;

    return true;
  }, []);

  const saveSharedAppData = useCallback(async (nextData, options = {}) => {
    const activeUser = currentUserRef.current;
    if (!activeUser) return false;
    if (!cloudReadyRef.current) {
      console.warn("Cloud save blocked until shared data finishes loading.");
      return false;
    }

    const payload = createSharedAppDataPayload(
      nextData,
      activeUser,
      realtimeClientIdRef.current
    );

    try {
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
    } catch (error) {
      console.error("Cloud save failed before Supabase returned a response:", error);
      return false;
    }

    lastCloudDataHashRef.current = getSharedAppDataHash(
      payload,
      DEFAULT_SCHEDULE_WEEKS
    );

    await createAppDataSnapshot(payload, options.snapshotReason || "auto-save");

    return true;
  }, [createAppDataSnapshot]);

  const loadSharedAppData = useCallback(async () => {
    const loadRequestId = cloudLoadRequestIdRef.current + 1;
    cloudLoadRequestIdRef.current = loadRequestId;
    cloudReadyRef.current = false;
    lastCloudDataHashRef.current = "";
    if (cloudSaveTimerRef.current) {
      clearTimeout(cloudSaveTimerRef.current);
      cloudSaveTimerRef.current = null;
    }
    setCloudDataLoaded(false);

    let data;
    let error;

    try {
      const result = await supabase
        .from("app_data")
        .select("data")
        .eq("id", APP_DATA_ID)
        .maybeSingle();
      data = result.data;
      error = result.error;
    } catch (loadError) {
      error = loadError;
    }

    if (loadRequestId !== cloudLoadRequestIdRef.current) return false;

    const initialData = resolveInitialSharedAppData({
      cloudRecord: data,
      cloudError: error,
      defaultScheduleWeeks: DEFAULT_SCHEDULE_WEEKS,
    });

    if (initialData.status === "load-error") {
      console.error("Cloud load failed:", error);
      return false;
    }

    if (initialData.status === "invalid-cloud-data") {
      console.error(
        "Cloud load returned an invalid app_data payload. Writes remain disabled to protect shared production data."
      );
      return false;
    }

    if (initialData.status === "missing-cloud-record") {
      console.error(
        "Cloud load returned no visible app_data row. Writes remain disabled because the row may be hidden by RLS."
      );
      return false;
    }

    const hydratedData = applyAppData(initialData.data);
    lastCloudDataHashRef.current = getSharedAppDataHash(
      hydratedData,
      DEFAULT_SCHEDULE_WEEKS
    );

    if (loadRequestId !== cloudLoadRequestIdRef.current) return false;

    cloudReadyRef.current = true;
    setCloudDataLoaded(true);
    return true;
  }, [applyAppData]);

  const loadSupabaseUser = useCallback(async (user) => {
    if (!user) {
      resetLocalSessionState();
      localStorage.removeItem("loggedInUser");
      localStorage.removeItem("currentRole");
      localStorage.removeItem("employeeDepartment");
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

    currentUserRef.current = safeUser;
    setCurrentUser(safeUser);
    localStorage.setItem("loggedInUser", JSON.stringify(safeUser));
    localStorage.setItem("currentRole", appRole);

    if (appRole === "Employee") {
      const nextDepartment = normalizeDepartment(
        profile?.department ||
          localStorage.getItem("employeeDepartment") ||
          "Fabrication"
      );
      setEmployeeDepartment(nextDepartment);
      setEmployeePanelTab(nextDepartment);
      setDashboardDepartment(nextDepartment);
      localStorage.setItem("employeeDepartment", nextDepartment);
      setView(nextDepartment);
    } else {
      // Prevent stale employee-only state from affecting Developer/Admin/Supervisor tools.
      localStorage.removeItem("employeeDepartment");
      setShopMessageTo("Everyone");
      setView("Live");
    }

    await loadSharedAppData();
  }, [loadSharedAppData, resetLocalSessionState]);

  const fetchShopMessages = useCallback(async () => {
    const { data, error } = await supabase
      .from("shop_messages")
      .select("id, created_at, sender_name, sender_role, department, message, attachment_url, attachment_name, acknowledgements")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      console.error("Could not load shop messages:", error);
      return null;
    }

    return Array.isArray(data) ? data : [];
  }, []);

  const refreshShopMessages = useCallback(async () => {
    const messages = await fetchShopMessages();
    if (messages) setShopMessages(messages);
  }, [fetchShopMessages]);

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
  }, [loadSupabaseUser]);

  useEffect(() => {
    const handleStorageLogout = (event) => {
      if (event.key !== "forgeflowLogoutAt") return;

      resetLocalSessionState();

      if (window.location.search) {
        window.history.replaceState({}, "", window.location.pathname || "/");
      }
    };

    window.addEventListener("storage", handleStorageLogout);

    return () => {
      window.removeEventListener("storage", handleStorageLogout);
    };
  }, [resetLocalSessionState]);

  useEffect(() => {
    const clearStaleBrowserShell = async () => {
      if (!localStorage.getItem("forgeflowLogoutAt")) return;

      if ("serviceWorker" in navigator) {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
        } catch (error) {
          console.warn("Could not unregister service workers:", error);
        }
      }

      if (window.caches) {
        try {
          const cacheNames = await window.caches.keys();
          await Promise.all(cacheNames.map((cacheName) => window.caches.delete(cacheName)));
        } catch (error) {
          console.warn("Could not clear app cache storage:", error);
        }
      }

      localStorage.removeItem("forgeflowLogoutAt");
    };

    clearStaleBrowserShell();
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
          if (!isValidCloudAppData(remoteData)) {
            console.error(
              "Ignored an invalid realtime app_data payload to protect shared production data."
            );
            return;
          }

          const hydratedData = applyAppData(remoteData);
          lastCloudDataHashRef.current = getSharedAppDataHash(
            hydratedData,
            DEFAULT_SCHEDULE_WEEKS
          );
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
  }, [applyAppData, currentUser, cloudDataLoaded]);

  useEffect(() => {
    if (!currentUser || !cloudDataLoaded) return;

    let isSubscribed = true;
    fetchShopMessages().then((messages) => {
      if (isSubscribed && messages) setShopMessages(messages);
    });

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
      isSubscribed = false;
      supabase.removeChannel(channel);
    };
  }, [currentUser, cloudDataLoaded, fetchShopMessages]);

  useEffect(() => {
    const currentAppData = {
      models,
      schedule,
      liveJobs,
      rawStockInventory,
      reusableDropInventory,
      scheduleWeeks,
    };
    const shouldSave = shouldPersistSharedAppData({
      isAuthenticated: Boolean(currentUser),
      isHydrated: cloudDataLoaded,
      isCloudReady: cloudReadyRef.current,
      currentData: currentAppData,
      lastSyncedHash: lastCloudDataHashRef.current,
      defaultScheduleWeeks: DEFAULT_SCHEDULE_WEEKS,
    });

    if (!shouldSave) return;

    if (cloudSaveTimerRef.current) {
      clearTimeout(cloudSaveTimerRef.current);
    }

    cloudSaveTimerRef.current = setTimeout(() => {
      saveSharedAppData(currentAppData);
    }, 900);

    return () => {
      if (cloudSaveTimerRef.current) {
        clearTimeout(cloudSaveTimerRef.current);
      }
    };
  }, [models, schedule, liveJobs, rawStockInventory, reusableDropInventory, scheduleWeeks, currentUser, cloudDataLoaded, saveSharedAppData]);
  useEffect(() => {
    localStorage.setItem("fishbowlConnectionSettings", JSON.stringify(fishbowlSettings));
  }, [fishbowlSettings]);

  useEffect(() => {
    localStorage.setItem("models", JSON.stringify(models));
  }, [models]);

  useEffect(() => {
    localStorage.setItem("schedule", JSON.stringify(schedule));
  }, [schedule]);

  useEffect(() => {
    localStorage.setItem("rawStockInventory", JSON.stringify(rawStockInventory));
  }, [rawStockInventory]);

  useEffect(() => {
    localStorage.setItem("reusableDropInventory", JSON.stringify(reusableDropInventory));
  }, [reusableDropInventory]);

  useEffect(() => {
    localStorage.setItem("liveJobs", JSON.stringify(liveJobs));
  }, [liveJobs]);

  useEffect(() => {
    localStorage.setItem("scheduleWeeks", JSON.stringify(scheduleWeeks));
  }, [scheduleWeeks]);

  useEffect(() => {
    if (!currentUser) {
      localStorage.removeItem("employeeDepartment");
      return;
    }

    if (currentRole === "Employee") {
      localStorage.setItem("employeeDepartment", employeeDepartment);
      return;
    }

    localStorage.removeItem("employeeDepartment");
  }, [employeeDepartment, currentRole, currentUser]);

  useEffect(() => {
    const nextStageMap = {};

    liveJobs.forEach((job) => {
      if (job?.id) {
        nextStageMap[job.id] = job.stage;
      }
    });

    if (!hasTrackedLiveStagesRef.current) {
      previousLiveJobStagesRef.current = nextStageMap;
      hasTrackedLiveStagesRef.current = true;
      return;
    }

    const movedIds = liveJobs
      .filter((job) => {
        if (!job?.id) return false;
        const previousStage = previousLiveJobStagesRef.current[job.id];
        return previousStage !== undefined && previousStage !== job.stage;
      })
      .map((job) => job.id);

    previousLiveJobStagesRef.current = nextStageMap;

    if (movedIds.length === 0) return;

    setRecentlyMovedJobIds((currentIds) =>
      Array.from(new Set([...currentIds, ...movedIds]))
    );

    const timer = setTimeout(() => {
      setRecentlyMovedJobIds((currentIds) =>
        currentIds.filter((id) => !movedIds.includes(id))
      );
    }, 2200);

    return () => clearTimeout(timer);
  }, [liveJobs]);

  const selectedModel = models.find((m) => m.id === selectedModelId);
  const elevatedModes = ["Developer", "Admin", "Supervisor"];
  const canManage = elevatedModes.includes(currentRole);
  const canDelete = currentRole === "Developer";
  const canDeleteShopMessages = canDelete || currentRole === "Admin";
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

  const getMaterialOptimizerJobs = () => {
    const activeScheduledJobs = schedule.filter((job) => job.status !== "Complete");

    if (materialOptimizerSource === "allScheduled") return activeScheduledJobs;

    if (materialOptimizerSource === "selectedJobs") {
      return filteredSchedule.filter((job) => job.status !== "Complete");
    }

    return activeScheduledJobs.filter(
      (job) => getJobWeekSlot(job) === Number(selectedScheduleWeek || 0)
    );
  };

  const filteredModels = models
    .filter((model) => {
      if (!hasSearch) return true;

      return (
        matches(model.name) ||
        model.types?.some((type) => furnitureMatchesSearch(model, type))
      );
    })
    .sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, {
        sensitivity: "base",
      })
    );

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

  const generateMaterialCutPlan = () => {
    const optimizerJobs = getMaterialOptimizerJobs();
    const nextPlan = buildMaterialOptimizerPlan(
      optimizerJobs,
      materialOptimizerMode,
      materialOptimizerSource,
      {
        reusableDropThreshold,
        kerf: optimizerKerf,
        rawStockInventory,
        reusableDropInventory,
      }
    );

    setMaterialCutPlan(nextPlan);
    setExpandedOptimizerPieces({});
  };

  const getMaterialOptimizerSourceLabel = (source = materialOptimizerSource) => {
    if (source === "currentWeek") {
      return `Current Week (${scheduleWeeks[selectedScheduleWeek] || `Week ${selectedScheduleWeek + 1}`})`;
    }

    if (source === "selectedJobs") return "Selected Jobs";
    if (source === "allScheduled") return "All Scheduled";

    return source || "Schedule";
  };

  const getOptimizerPieceKey = (materialType, rawNumber) => `${materialType || "material"}-${rawNumber}`;

  const toggleOptimizerPiece = (pieceKey) => {
    setExpandedOptimizerPieces((current) => ({
      ...current,
      [pieceKey]: !current[pieceKey],
    }));
  };

  const formatMaterialSizeLabel = (value) => {
    return String(value || "")
      .replace(/\s*[xX×]\s*/g, " x ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const normalizeInventoryMaterialKey = (value) => {
    return String(value || "")
      .toLowerCase()
      .replace(/\s*[xX×Ã—]\s*/g, "x")
      .replace(/\s+/g, "")
      .trim();
  };

  const commitMaterialPlan = () => {
    if (!materialCutPlan?.projectedInventoryImpact) return;

    const impact = materialCutPlan.projectedInventoryImpact;
    const currentRawStockByMaterial = rawStockInventory.reduce((acc, item) => {
      const key = normalizeInventoryMaterialKey(item.materialType);
      acc[key] = (acc[key] || 0) + Number(item.quantityOnHand || 0);
      return acc;
    }, {});
    const shortages = impact.rawStockUsed
      .map((row) => {
        const availablePieces = currentRawStockByMaterial[normalizeInventoryMaterialKey(row.materialType)] || 0;
        return {
          materialType: row.materialType,
          shortagePieces: Math.max(0, Number(row.projectedPiecesUsed || 0) - availablePieces),
        };
      })
      .filter((row) => row.shortagePieces > 0);

    if (shortages.length > 0) {
      const shortageList = shortages
        .map((row) => `${formatMaterialSizeLabel(row.materialType)}: short ${row.shortagePieces} piece${row.shortagePieces === 1 ? "" : "s"}`)
        .join("\n");
      const confirmed = window.confirm(
        `Inventory is short for this material plan.\n\n${shortageList}\n\nCommit anyway and allow projected raw stock inventory to go negative?`
      );

      if (!confirmed) return;
    }

    const committedAt = new Date().toISOString();
    const createdDate = committedAt.slice(0, 10);
    const sourcePlanId = `material-plan-${materialCutPlan.generatedAt || committedAt}`;
    const usedDropIds = new Set((impact.reusableDropsUsed || []).map((drop) => drop.id).filter(Boolean));
    const usedDropDetails = (impact.reusableDropsUsed || []).reduce((acc, drop) => {
      if (drop.id) acc[drop.id] = drop;
      return acc;
    }, {});

    const newReusableDrops = (impact.newReusableDrops || [])
      .filter((drop) => Number(drop.length || 0) >= Number(materialCutPlan.settings?.reusableDropThreshold ?? reusableDropThreshold))
      .map((drop) => ({
        id: makeId(),
        materialType: drop.materialType || "",
        length: Number(drop.length || 0),
        createdDate,
        status: "Available",
        sourcePlanId,
        assignedJob: "",
        notes: "",
      }));

    setRawStockInventory((current) => {
      const next = current.map((item) => ({ ...item }));

      (impact.rawStockUsed || []).forEach((usage) => {
        let remainingToSubtract = Math.max(0, Number(usage.projectedPiecesUsed || 0));
        if (remainingToSubtract === 0) return;

        const usageKey = normalizeInventoryMaterialKey(usage.materialType);
        const matchingIndexes = next
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => normalizeInventoryMaterialKey(item.materialType) === usageKey)
          .map(({ index }) => index);

        matchingIndexes.forEach((index) => {
          if (remainingToSubtract <= 0) return;

          const available = Number(next[index].quantityOnHand || 0);
          const subtract = Math.min(available, remainingToSubtract);
          next[index].quantityOnHand = available - subtract;
          remainingToSubtract -= subtract;
        });

        if (remainingToSubtract > 0 && matchingIndexes.length > 0) {
          const index = matchingIndexes[0];
          next[index].quantityOnHand = Number(next[index].quantityOnHand || 0) - remainingToSubtract;
          remainingToSubtract = 0;
        }

        if (remainingToSubtract > 0) {
          next.unshift({
            id: makeId(),
            materialType: usage.materialType || "Unspecified Material",
            stockLength: 240,
            quantityOnHand: -remainingToSubtract,
            notes: "",
          });
        }
      });

      return next;
    });

    setReusableDropInventory((current) => {
      const updatedDrops = current.map((drop) => {
        if (!usedDropIds.has(drop.id)) return drop;

        const detail = usedDropDetails[drop.id] || {};

        return {
          ...drop,
          status: "Used",
          assignedJob: drop.assignedJob || detail.furniture || "",
          sourcePlanId: drop.sourcePlanId || sourcePlanId,
          notes: drop.notes || "",
        };
      });

      return [...newReusableDrops, ...updatedDrops];
    });

    setMaterialCutPlan((current) => current ? { ...current, inventoryCommittedAt: committedAt } : current);
    alert(`Material plan committed. Added ${newReusableDrops.length} reusable drop${newReusableDrops.length === 1 ? "" : "s"} and updated raw stock inventory.`);
  };

  const printScheduleCutPlan = () => {
    const previousTitle = document.title;
    const restoreTitle = () => {
      document.title = previousTitle;
    };

    document.title = "\u00a0";
    window.addEventListener("afterprint", restoreTitle, { once: true });
    window.print();
  };

  const saveRawStockItem = () => {
    if (!rawStockForm.materialType.trim()) return;

    const item = {
      id: editingRawStockId || makeId(),
      materialType: rawStockForm.materialType.trim(),
      stockLength: Number(rawStockForm.stockLength || 240),
      quantityOnHand: Number(rawStockForm.quantityOnHand || 0),
      notes: rawStockForm.notes || "",
    };

    setRawStockInventory((current) =>
      editingRawStockId
        ? current.map((stock) => (stock.id === editingRawStockId ? item : stock))
        : [item, ...current]
    );
    setRawStockForm(emptyRawStockForm);
    setEditingRawStockId(null);
  };

  const editRawStockItem = (item) => {
    setEditingRawStockId(item.id);
    setRawStockForm({
      materialType: item.materialType || "",
      stockLength: String(item.stockLength || 240),
      quantityOnHand: String(item.quantityOnHand || ""),
      notes: item.notes || "",
    });
  };

  const deleteRawStockItem = (itemId) => {
    if (!confirmPermanentDelete("this raw stock material")) return;
    setRawStockInventory((current) => current.filter((item) => item.id !== itemId));
  };

  const saveReusableDropItem = () => {
    if (!reusableDropForm.materialType.trim() || !reusableDropForm.length) return;
    const existingDrop = reusableDropInventory.find((drop) => drop.id === editingReusableDropId);

    const item = {
      id: editingReusableDropId || makeId(),
      materialType: reusableDropForm.materialType.trim(),
      length: Number(reusableDropForm.length || 0),
      createdDate: reusableDropForm.createdDate || new Date().toISOString().slice(0, 10),
      status: reusableDropForm.status || "Available",
      sourcePlanId: reusableDropForm.sourcePlanId || existingDrop?.sourcePlanId || "",
      assignedJob: existingDrop?.assignedJob || "",
      notes: reusableDropForm.notes || "",
    };

    setReusableDropInventory((current) =>
      editingReusableDropId
        ? current.map((drop) => (drop.id === editingReusableDropId ? item : drop))
        : [item, ...current]
    );
    setReusableDropForm(emptyReusableDropForm);
    setEditingReusableDropId(null);
  };

  const editReusableDropItem = (item) => {
    setEditingReusableDropId(item.id);
    setReusableDropForm({
      materialType: item.materialType || "",
      length: String(item.length || ""),
      createdDate: item.createdDate || "",
      status: item.status || "Available",
      sourcePlanId: item.sourcePlanId || "",
      notes: item.notes || "",
    });
  };

  const updateReusableDropStatus = (itemId, status) => {
    setReusableDropInventory((current) =>
      current.map((drop) => (drop.id === itemId ? { ...drop, status } : drop))
    );
  };

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

  const activeLiveJobs = useMemo(
    () => liveJobs.filter((job) => Number(job.stage || 0) < STAGES.length - 1),
    [liveJobs]
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
      activeJobs: activeLiveJobs.length,
    };
  }, [schedule, activeLiveJobs]);

  const selectedWeekJobMetrics = useMemo(
    () => getWeekJobMetrics(schedule, activeLiveJobs, selectedScheduleWeek),
    [schedule, activeLiveJobs, selectedScheduleWeek]
  );

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
      ? `
          <div style="
            grid-column:3;
            justify-self:end;
            padding:8px;
            border:1px solid #d5d5d5;
            background:#f8f8f8;
          ">
            <img class="cut-image" crossorigin="anonymous" src="${type.image}" alt="" />
          </div>
        `
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
        display:grid;
        grid-template-columns:minmax(0, 1fr) auto minmax(0, 1fr);
        align-items:center;
        column-gap:28px;
        border-bottom:2px solid #111;
        padding-bottom:18px;
        margin-bottom:20px;
      ">
        <div style="
          grid-column:1;
          min-width:0;
          text-align:left;
          color:#111 !important;
        ">
          <h1 style="
            margin:0 0 6px;
            font-size:28px;
            color:#111 !important;
          ">
            ${type.name}
          </h1>

          <h2 style="
            margin:0;
            font-size:18px;
            color:#333 !important;
          ">
            ${model.name}
          </h2>

          <div style="
            display:grid;
            gap:6px;
            margin-top:18px;
            line-height:1.5;
            font-size:14px;
            color:#111 !important;
          ">
            <div><b>Total Parts:</b> ${parts.length}</div>
            <div><b>Generated:</b> ${generatedDate}</div>
          </div>
        </div>

        <div style="
          grid-column:2;
          justify-self:center;
          text-align:center;
          color:#111 !important;
        ">
          <div style="
            font-size:32px;
            font-weight:bold;
            letter-spacing:2px;
          ">
            ADMIRAL
          </div>

          <div style="
            font-size:14px;
            margin-top:-7px;
            letter-spacing:1px;
            color:#555 !important;
          ">
            OUTDOOR
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
        display:block;
        width:190px;
        max-width:190px;
        max-height:145px;
        object-fit:contain;
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
      rawStockInventory,
      reusableDropInventory,
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
          rawStockInventory: Array.isArray(backup.rawStockInventory) ? backup.rawStockInventory : [],
          reusableDropInventory: Array.isArray(backup.reusableDropInventory) ? backup.reusableDropInventory : [],
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
      timeline: [
        makeTimelineEvent(
          "Fabrication",
          "Released to production",
          `Qty ${remaining} released from ${getScheduleDateLabel(scheduleWeeks, scheduleJob)}.`
        ),
      ],
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
              partsReadyAt: !job.partsReady ? new Date().toISOString() : null,
              timeline: [
                ...getJobTimeline(job),
                makeTimelineEvent(
                  "Fabrication",
                  !job.partsReady ? "Parts marked ready" : "Parts marked not ready",
                  !job.partsReady
                    ? "Fabrication completed the cut list for this job."
                    : "Job was moved back to fabrication-in-progress status."
                ),
              ],
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
              timeline: [
                ...getJobTimeline(item),
                makeTimelineEvent(
                  STAGES[nextStage],
                  `Moved to ${STAGES[nextStage]}`,
                  `Advanced from ${STAGES[job.stage]} to ${STAGES[nextStage]}.`
                ),
              ],
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

  const departmentPanelsForView = (department) => {
    if (department === "Welding") {
      return [
        { title: "Fabrication", stageName: "Fabrication", jobs: liveForStage(0) },
        { title: "Welding", stageName: "Welding", jobs: liveForStage(1) },
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
      return [
        { title: "Welding", stageName: "Welding", jobs: liveForStage(1) },
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
      refreshShopMessages();
    }
  };

  const sendShopMessage = async (event) => {
    event.preventDefault();

    const cleanMessage = shopMessageText.trim();
    if (!cleanMessage || !currentUser || shopMessageSending) {
      console.info("Shop message send skipped:", {
        hasMessage: Boolean(cleanMessage),
        hasUser: Boolean(currentUser),
        alreadySending: shopMessageSending,
      });
      return;
    }

    const messagePayload = {
      sender_name: currentUser.displayName || currentUser.username || currentRole,
      sender_role: getShopMessageFromLabel(),
      department: shopMessageTo || "Everyone",
      message: cleanMessage,
      attachment_url: shopMessagePhoto,
      attachment_name: shopMessagePhotoName,
      acknowledgements: [],
    };

    setShopMessageSending(true);
    console.info("Sending shop message:", {
      from: messagePayload.sender_role,
      to: messagePayload.department,
      user: messagePayload.sender_name,
    });

    const { data, error } = await supabase
      .from("shop_messages")
      .insert(messagePayload)
      .select("id, created_at, sender_name, sender_role, department, message, attachment_url, attachment_name, acknowledgements")
      .single();

    setShopMessageSending(false);

    if (error) {
      console.error("Could not send shop message:", error, messagePayload);
      alert("Could not send that message. Check Supabase and try again.");
      return;
    }

    if (data) {
      setShopMessages((currentMessages) => {
        if (currentMessages.some((message) => message.id === data.id)) {
          return currentMessages;
        }

        return [data, ...currentMessages].slice(0, 100);
      });
    } else {
      console.warn("Shop message insert succeeded but Supabase returned no row.");
      refreshShopMessages();
    }

    setShopMessageText("");
    clearShopMessagePhoto();
  };

  const deleteShopMessage = async (messageId) => {
    if (!canDeleteShopMessages) return;
    if (shopMessageDeleteInFlightRef.current) return;

    if (
      messageId === null ||
      messageId === undefined ||
      String(messageId).trim() === ""
    ) {
      const missingIdMessage =
        "Could not delete this shop note because its database ID is missing.";
      console.error(missingIdMessage);
      setShopMessageDeleteError(missingIdMessage);
      window.alert(missingIdMessage);
      return;
    }

    if (!window.confirm("Delete this shop note?")) return;

    shopMessageDeleteInFlightRef.current = true;
    setShopMessageDeletingId(messageId);
    setShopMessageDeleteError("");
    console.info("Deleting shop note:", { messageId });

    try {
      const { data: deletedMessage, error } = await supabase
        .from("shop_messages")
        .delete()
        .eq("id", messageId)
        .select("id")
        .maybeSingle();

      if (error) throw error;

      if (
        !deletedMessage?.id ||
        String(deletedMessage.id) !== String(messageId)
      ) {
        const unconfirmedDeleteError = new Error(
          "Supabase did not return the deleted shop note."
        );
        unconfirmedDeleteError.code = "SHOP_NOTE_DELETE_NOT_CONFIRMED";
        throw unconfirmedDeleteError;
      }

      setShopMessages((currentMessages) =>
        currentMessages.filter(
          (message) => String(message.id) !== String(messageId)
        )
      );
      console.info("Shop note deleted:", { messageId });
    } catch (error) {
      const errorText = String(error?.message || "").toLowerCase();
      const permissionBlocked =
        error?.code === "42501" ||
        errorText.includes("row-level security") ||
        errorText.includes("permission");
      const deleteErrorMessage =
        error?.code === "SHOP_NOTE_DELETE_NOT_CONFIRMED"
          ? "Supabase did not confirm this deletion. The note may no longer exist, or the database delete policy did not permit this account."
          : permissionBlocked
            ? "Could not delete this shop note because this account is not permitted by the Supabase delete policy."
            : "Could not delete this shop note from the database. Please try again.";

      console.error("Could not delete shop note:", {
        messageId,
        code: error?.code,
        message: error?.message,
        details: error?.details,
        hint: error?.hint,
      });
      setShopMessageDeleteError(deleteErrorMessage);
      window.alert(deleteErrorMessage);
    } finally {
      shopMessageDeleteInFlightRef.current = false;
      setShopMessageDeletingId(null);
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
    } catch {
      return "";
    }
  };

  const formatTimelineTime = (value) => {
    if (!value) return "Not recorded";

    try {
      return new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return "Not recorded";
    }
  };

  const makeTimelineEvent = (stage, title, note = "") => ({
    id: makeId(),
    stage,
    title,
    note,
    at: new Date().toISOString(),
    by: currentUser?.displayName || currentUser?.username || currentRole || "System",
  });

  const getJobTimeline = (job) => {
    const savedTimeline = Array.isArray(job.timeline) ? job.timeline : [];

    if (savedTimeline.length > 0) {
      return savedTimeline;
    }

    const inferred = [];

    if (job.startedAt) {
      inferred.push({
        id: `started-${job.id}`,
        stage: "Fabrication",
        title: "Released to production",
        note: `Qty ${job.qty || 0} moved from schedule into live production.`,
        at: job.startedAt,
        by: "System",
      });
    }

    if (job.partsReady) {
      inferred.push({
        id: `parts-${job.id}`,
        stage: "Fabrication",
        title: "Parts marked ready",
        note: "Fabrication is ready to send this job forward.",
        at: job.partsReadyAt || job.startedAt || "",
        by: "System",
      });
    }

    STAGES.slice(1, Math.min(job.stage + 1, STAGES.length)).forEach((stage, index) => {
      inferred.push({
        id: `stage-${job.id}-${stage}`,
        stage,
        title: `Reached ${stage}`,
        note: index === job.stage - 1 ? "Current recorded stage." : "Previous production stage.",
        at: job.startedAt || "",
        by: "System",
      });
    });

    return inferred;
  };

  const getScheduleTimeline = (job) => {
    const events = [];

    if (job.createdAt) {
      events.push({
        id: `schedule-created-${job.id}`,
        stage: "Scheduled",
        title: "Scheduled",
        note: `Qty ${job.qtyNeeded || 0} added to ${getScheduleDateLabel(scheduleWeeks, job)}.`,
        at: job.createdAt,
        by: "System",
      });
    }

    if (job.status === "In Production") {
      const matchingLiveJob = liveJobs.find((liveJob) => liveJob.scheduleId === job.id);
      events.push({
        id: `schedule-production-${job.id}`,
        stage: matchingLiveJob ? STAGES[matchingLiveJob.stage] : "In Production",
        title: "Released to live production",
        note: matchingLiveJob
          ? `Currently in ${STAGES[matchingLiveJob.stage]} with qty ${matchingLiveJob.qty || 0}.`
          : "This job has been released from the schedule.",
        at: matchingLiveJob?.startedAt || job.createdAt || "",
        by: "System",
      });
    }

    if (job.status === "Complete") {
      events.push({
        id: `schedule-complete-${job.id}`,
        stage: "Complete",
        title: "Completed",
        note: `Completed ${job.qtyComplete || job.qtyNeeded || 0} of ${job.qtyNeeded || 0}.`,
        at: job.completedAt || job.createdAt || "",
        by: "System",
      });
    }

    return events;
  };

  const openShopMessageAttachment = (message) => {
    if (!message?.attachment_url) return;

    setSelectedShopMessageAttachment({
      url: message.attachment_url,
      name: message.attachment_name || "Shop note attachment",
      message: message.message || "",
      from: message.sender_role || "Team",
      to: message.department || "Everyone",
      at: message.created_at || "",
    });
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

  const clearAuthStorage = () => {
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
    localStorage.setItem("forgeflowLogoutAt", String(Date.now()));
    sessionStorage.clear();
  };

  const clearBrowserShellCache = async () => {
    if ("serviceWorker" in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
      } catch (error) {
        console.warn("Could not unregister service workers during logout:", error);
      }
    }

    if (window.caches) {
      try {
        const cacheNames = await window.caches.keys();
        await Promise.all(cacheNames.map((cacheName) => window.caches.delete(cacheName)));
      } catch (error) {
        console.warn("Could not clear browser cache storage during logout:", error);
      }
    }
  };

  const handleLogout = async () => {
    if (!window.confirm("Log out of this device?")) return;

    // Flip the UI to logged-out immediately so the button cannot get stuck behind a slow network/auth call.
    resetLocalSessionState();

    try {
      await Promise.race([
        supabase.auth.signOut({ scope: "global" }),
        new Promise((resolve) => setTimeout(resolve, 1800)),
      ]);
    } catch (error) {
      console.warn("Supabase logout did not finish cleanly, local session was still cleared:", error);
    }

    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch (error) {
      console.warn("Could not clear local Supabase session through auth client:", error);
    }

    clearAuthStorage();
    await clearBrowserShellCache();

    const cleanPath = window.location.pathname || "/";
    window.history.replaceState({}, "", cleanPath);
    window.location.replace(cleanPath);
  };

  const handleEmployeeDepartmentChange = (department) => {
    if (!EMPLOYEE_DEPARTMENTS.includes(department)) return;

    setEmployeeDepartment(department);
    setEmployeePanelTab(department);
    setDashboardDepartment(department);

    if (currentRole === "Employee") {
      localStorage.setItem("employeeDepartment", department);
      setView(department);
    }
  };

  const WeldingTorchIcon = ({ size = 20 }) => (
    <svg
      className="ff-ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="m4 20 7.5-7.5" />
      <path d="m8.5 15.5-2-2L12 8l2 2-5.5 5.5Z" />
      <path d="m14 10 2.3-2.3" />
      <path d="m16.3 7.7 2 2" />
      <path d="M19 4.5 20.5 3" />
      <path d="M20 7l2-.6" />
      <path d="M16.5 3.5 16 1.8" />
      <path d="M21 10.5h1.7" />
    </svg>
  );

  const SawBladeIcon = ({ size = 20 }) => (
    <svg
      className="ff-ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M12 2.5 13.1 5l2-2 0.4 2.8 2.5-1.3-0.4 2.8 2.8-0.4-1.3 2.5 2.8 0.4-2 2 2 2-2.8 0.4 1.3 2.5-2.8-0.4 0.4 2.8-2.5-1.3-0.4 2.8-2-2L12 21.5 10.9 19l-2 2-0.4-2.8L6 19.5l0.4-2.8-2.8 0.4 1.3-2.5-2.8-0.4 2-2-2-2 2.8-0.4-1.3-2.5 2.8 0.4L6 4.5l2.5 1.3L8.9 3l2 2L12 2.5Z" />
      <circle cx="12" cy="12" r="2.2" />
    </svg>
  );

  const StageIcon = ({ stageName, size = 20 }) => {
    if (stageName === "Fabrication") return <SawBladeIcon size={size} />;
    if (stageName === "Welding") return <WeldingTorchIcon size={size} />;
    if (stageName === "Assembly") return <Wrench size={size} />;
    if (stageName === "Paint Line") return <PaintBucket size={size} />;
    if (stageName === "Shipping") return <Truck size={size} />;
    return <PackageCheck size={size} />;
  };

  const renderNavIcon = (name) => {
    const icons = {
      Models: Package2,
      Schedule: CalendarDays,
      Live: Activity,
      Messages: MessageSquare,
      Dashboard: LayoutDashboard,
      Fishbowl: Database,
      Analytics: BarChart3,
      "Material Optimizer": ScanSearch,
      "Material Inventory": Boxes,
    };
    const Icon = icons[name];
    return Icon ? <Icon size={18} /> : null;
  };

  const runLiveActionWithoutJump = (action) => {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    action();

    requestAnimationFrame(() => {
      window.scrollTo(scrollX, scrollY);
      requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
    });
  };

  const StageBadge = ({ stage }) => {
    const stageName = STAGES[stage];
    return (
      <span className={`stage-badge stage-${stageSlug(stageName)}`}>
        <StageIcon stageName={stageName} size={16} />
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

          <details className="job-timeline">
            <summary><ChevronRight size={18} /> Job Timeline</summary>
            <div className="job-timeline-list">
              {getJobTimeline(job).map((event) => (
                <div key={event.id || `${event.stage}-${event.at}`} className="job-timeline-item">
                  <span className={`timeline-dot stage-${stageSlug(event.stage)}`} />
                  <div>
                    <b>{event.title}</b>
                    <small>{event.stage} • {formatTimelineTime(event.at)}</small>
                    {event.note && <p>{event.note}</p>}
                    {event.by && <em>By {event.by}</em>}
                  </div>
                </div>
              ))}
            </div>
          </details>
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
              <Eye size={18} />
              View Cut Sheet
            </button>
          )}

          {isFabrication && !isComplete && (
            <>
              <div className={job.partsReady ? "status good" : "status warning"}>
                {job.partsReady ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}
                <span>
                  {job.partsReady
                    ? "Parts are ready for welding"
                    : "Cutting / fabrication in progress"}
                </span>
              </div>

              {canOperateJobs && (
                <div className="button-row compact-action-row">
                  <button onClick={() => runLiveActionWithoutJump(() => togglePartsReady(job.id))}>
                    {job.partsReady ? <RotateCcw size={18} /> : <CheckCircle2 size={18} />}
                    {job.partsReady ? "Mark Not Ready" : "Mark Parts Ready"}
                  </button>

                  <button
                    disabled={!job.partsReady}
                    onClick={() => runLiveActionWithoutJump(() => moveLiveJob(job.id))}
                  >
                    <ArrowRight size={18} />
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
                    <button onClick={() => runLiveActionWithoutJump(() => updateStageQty(job.id, 1))}>+1</button>
                    <button onClick={() => runLiveActionWithoutJump(() => updateStageQty(job.id, 10))}>+10</button>
                    <button onClick={() => runLiveActionWithoutJump(() => updateStageQty(job.id, -1))}>-1</button>
                  </div>

                  <button className="wide" onClick={() => runLiveActionWithoutJump(() => moveLiveJob(job.id))}>
                    <ArrowRight size={18} />
                    Move To {STAGES[job.stage + 1]}
                  </button>
                </>
              )}
            </>
          )}

          {isComplete && <div className="status good"><CheckCircle2 size={18} /><span>Order Sent / Complete</span></div>}

          {canRemoveLiveJob && (
            <button className="danger wide" onClick={() => runLiveActionWithoutJump(() => removeLiveJob(job.id))}>
              <Trash2 size={18} />
              Remove Live Job
            </button>
          )}
        </div>
      </div>
    );
  };

  const updateFishbowlSetting = (field, value) => {
    setFishbowlSettings((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const testFishbowlConnection = () => {
    const missingFields = [
      ["Server / Host", fishbowlSettings.serverUrl],
      ["API Port", fishbowlSettings.apiPort],
      ["Database", fishbowlSettings.databaseName],
      ["Username", fishbowlSettings.username],
    ].filter(([, value]) => !String(value || "").trim());

    if (missingFields.length > 0) {
      setFishbowlConnectionNote(
        `Connection profile saved as a draft. Still waiting on: ${missingFields
          .map(([label]) => label)
          .join(", ")}.`
      );
      return;
    }

    setFishbowlSettings((current) => ({
      ...current,
      lastTestedAt: new Date().toISOString(),
    }));

    setFishbowlConnectionNote(
      "Connection profile is ready. Once IT gives us the real endpoint/auth method, this page can be wired to live Fishbowl sync."
    );
  };

  const renderFishbowlConnectionPage = () => {
    const readyFields = [
      fishbowlSettings.serverUrl,
      fishbowlSettings.apiPort,
      fishbowlSettings.databaseName,
      fishbowlSettings.username,
    ].filter((value) => String(value || "").trim()).length;

    return (
      <section className="enterprise-page fishbowl-page">
        <div className="enterprise-hero-card">
          <div>
            <span className="eyebrow">Integration Center</span>
            <h1>Fishbowl Connection</h1>
            
          </div>
          <div className="enterprise-status-orb">
            <b>{readyFields}/4</b>
            <span>Fields Ready</span>
          </div>
        </div>

        <div className="enterprise-grid">
          <div className="enterprise-card">
            <h2>Connection Profile</h2>
            <p className="muted">Save non-password setup details here so the real connector can be added cleanly later.</p>

            <div className="form-grid">
              <label>
                Server / Host
                <input
                  value={fishbowlSettings.serverUrl || ""}
                  onChange={(e) => updateFishbowlSetting("serverUrl", e.target.value)}
                  placeholder="Example: fishbowl.company.local"
                />
              </label>

              <label>
                API Port
                <input
                  value={fishbowlSettings.apiPort || ""}
                  onChange={(e) => updateFishbowlSetting("apiPort", e.target.value)}
                  placeholder="Ask IT for the port"
                />
              </label>

              <label>
                Database / Company File
                <input
                  value={fishbowlSettings.databaseName || ""}
                  onChange={(e) => updateFishbowlSetting("databaseName", e.target.value)}
                  placeholder="Fishbowl database name"
                />
              </label>

              <label>
                Integration Username
                <input
                  value={fishbowlSettings.username || ""}
                  onChange={(e) => updateFishbowlSetting("username", e.target.value)}
                  placeholder="Dedicated API/import user"
                />
              </label>

              <label>
                Sync Mode
                <select
                  value={fishbowlSettings.syncMode || "Manual CSV Import"}
                  onChange={(e) => updateFishbowlSetting("syncMode", e.target.value)}
                >
                  <option>Manual CSV Import</option>
                  <option>One-Way Fishbowl to ForgeFlow</option>
                  <option>Two-Way Sync Review Required</option>
                </select>
              </label>
            </div>

            <div className="button-row">
              <button onClick={testFishbowlConnection}>Save / Check Profile</button>
              <button className="secondary" onClick={() => fishbowlCsvInputRef.current?.click()}>Import CSV Now</button>
            </div>

            {fishbowlConnectionNote && <div className="status warning">{fishbowlConnectionNote}</div>}
            {fishbowlImportSummary && <div className="status good">{fishbowlImportSummary}</div>}
          </div>

          <div className="enterprise-card">
            <h2>Implementation Plan</h2>
            <div className="integration-steps">
              <div><b>1</b><span>Manual CSV import stays active as the safe fallback.</span></div>
              <div><b>2</b><span>IT provides approved Fishbowl server/API details.</span></div>
              <div><b>3</b><span>ForgeFlow pulls schedule rows into a review queue.</span></div>
              <div><b>4</b><span>Supervisor approves imports before they hit the live schedule.</span></div>
              <div><b>5</b><span>Automatic scheduled sync can be enabled after testing.</span></div>
            </div>
          </div>

          <div className="enterprise-card enterprise-card-wide">
            <h2>Data Mapping</h2>
            <div className="mapping-grid">
              <span>Fishbowl Item / Description</span><b>ForgeFlow Furniture Name</b>
              <span>Item Number / SKU</span><b>SKU</b>
              <span>Quantity / Qty Needed</span><b>Scheduled Qty</b>
              <span>Due Date / Ship Date / Promise Date</span><b>Schedule Week</b>
              <span>SO / WO / Customer / Priority</span><b>Job Notes</b>
            </div>
          </div>
        </div>
      </section>
    );
  };

  const renderDeveloperAnalyticsPage = () => {
    const totalFurniture = models.reduce((sum, model) => sum + (model.types?.length || 0), 0);
    const totalParts = models.reduce(
      (sum, model) =>
        sum +
        (model.types || []).reduce(
          (typeSum, type) => typeSum + (type.parts?.length || 0),
          0
        ),
      0
    );

    const scheduledQty = schedule.reduce((sum, job) => sum + Number(job.qtyNeeded || 0), 0);
    const completedQty = schedule.reduce((sum, job) => sum + Number(job.qtyComplete || 0), 0);
    const inProductionQty = activeLiveJobs.reduce((sum, job) => sum + Number(job.qty || 0), 0);
    const scheduledOnlyJobs = schedule.filter((job) => job.status === "Scheduled");
    const inProductionJobs = schedule.filter((job) => job.status === "In Production");
    const completedJobs = schedule.filter((job) => job.status === "Complete");
    const completionRate = scheduledQty > 0 ? Math.round((completedQty / scheduledQty) * 100) : 0;

    const stageRows = STAGES.slice(0, -1).map((stage, index) => {
      const jobs = liveForStage(index);
      const qty = jobs.reduce((sum, job) => sum + Number(job.qty || 0), 0);
      return { stage, jobs: jobs.length, qty };
    });

    const collectionRows = Object.values(
      schedule.reduce((acc, job) => {
        const key = job.collection || "Unassigned";
        if (!acc[key]) acc[key] = { collection: key, jobs: 0, qty: 0, complete: 0 };
        acc[key].jobs += 1;
        acc[key].qty += Number(job.qtyNeeded || 0);
        acc[key].complete += Number(job.qtyComplete || 0);
        return acc;
      }, {})
    )
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 8);

    const maxCollectionQty = Math.max(1, ...collectionRows.map((row) => row.qty));
    const maxStageQty = Math.max(1, ...stageRows.map((row) => row.qty));

    const recentCompleted = completedJobs
      .filter((job) => job.completedAt)
      .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
      .slice(0, 6);

    return (
      <section className="enterprise-page analytics-page">
        <div className="enterprise-hero-card analytics-hero-card">
          <div>
            <span className="eyebrow">Developer Analytics</span>
            <h1>ForgeFlow Production Intelligence</h1>
            <p>
              Private Dev-mode analytics for throughput, backlog, live WIP, collection load,
              and current production flow.
            </p>
          </div>
          <div className="enterprise-status-orb analytics-orb">
            <b>{completionRate}%</b>
            <span>Completion</span>
          </div>
        </div>

        <div className="analytics-kpi-grid">
          <div className="analytics-kpi-card"><span>Scheduled Qty</span><b>{scheduledQty}</b><small>{schedule.length} jobs</small></div>
          <div className="analytics-kpi-card"><span>Completed Qty</span><b>{completedQty}</b><small>{completedJobs.length} complete jobs</small></div>
          <div className="analytics-kpi-card"><span>Live WIP Qty</span><b>{inProductionQty}</b><small>{activeLiveJobs.length} active live jobs</small></div>
          <div className="analytics-kpi-card"><span>Model Library</span><b>{totalFurniture}</b><small>{models.length} collections / {totalParts} parts</small></div>
          <div className="analytics-kpi-card"><span>Backlog Split</span><b>{scheduledOnlyJobs.length}</b><small>{inProductionJobs.length} in production</small></div>
        </div>

        <div className="enterprise-grid analytics-grid">
          <div className="enterprise-card analytics-card">
            <h2>Live Work by Department</h2>
            <p className="muted">Shows where active production quantity is sitting right now.</p>
            <div className="analytics-bar-list">
              {stageRows.map((row) => (
                <div key={row.stage} className="analytics-bar-row">
                  <div className="analytics-bar-label"><b>{row.stage}</b><span>{row.jobs} jobs • {row.qty} qty</span></div>
                  <div className="analytics-bar-track"><span style={{ width: `${Math.max(4, (row.qty / maxStageQty) * 100)}%` }} /></div>
                </div>
              ))}
            </div>
          </div>

          <div className="enterprise-card analytics-card">
            <h2>Scheduled Load by Collection</h2>
            <p className="muted">Top collections by scheduled quantity.</p>
            {collectionRows.length === 0 ? (
              <div className="empty small">No schedule data yet.</div>
            ) : (
              <div className="analytics-bar-list">
                {collectionRows.map((row) => (
                  <div key={row.collection} className="analytics-bar-row">
                    <div className="analytics-bar-label"><b>{row.collection}</b><span>{row.jobs} jobs • {row.complete}/{row.qty} complete</span></div>
                    <div className="analytics-bar-track"><span style={{ width: `${Math.max(4, (row.qty / maxCollectionQty) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="enterprise-card analytics-card">
            <h2>Schedule Health</h2>
            <div className="analytics-health-grid">
              <div><span>Scheduled Jobs</span><b>{selectedWeekJobMetrics.scheduledJobs}</b></div>
              <div><span>In Production</span><b>{selectedWeekJobMetrics.activeJobs}</b></div>
              <div><span>Complete</span><b>{selectedWeekJobMetrics.completedJobs}</b></div>
              <div><span>Remaining Jobs</span><b>{selectedWeekJobMetrics.remainingJobs}</b></div>
            </div>
          </div>

          <div className="enterprise-card analytics-card">
            <h2>Recent Completions</h2>
            {recentCompleted.length === 0 ? (
              <div className="empty small">No completed jobs with timestamps yet.</div>
            ) : (
              <div className="analytics-completion-list">
                {recentCompleted.map((job) => (
                  <div key={job.id}>
                    <b>{job.furniture}</b>
                    <span>{job.collection} • Qty {job.qtyComplete || job.qtyNeeded || 0}</span>
                    <small>{formatTimelineTime(job.completedAt)}</small>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    );
  };

  const formatCutNumberLabel = (cutNumbers) => {
    const sortedNumbers = Array.from(
      new Set(
        cutNumbers
          .map((number) => Number(number))
          .filter((number) => Number.isFinite(number))
      )
    ).sort((a, b) => a - b);

    if (sortedNumbers.length === 0) return "-";

    const isContinuous = sortedNumbers.every(
      (number, index) => index === 0 || number === sortedNumbers[index - 1] + 1
    );

    if (isContinuous && sortedNumbers.length > 1) {
      return `${sortedNumbers[0]}-${sortedNumbers[sortedNumbers.length - 1]}`;
    }

    return sortedNumbers.join(", ");
  };

  const groupCutsForDisplay = (cuts) => {
    const groups = new Map();

    (Array.isArray(cuts) ? cuts : []).forEach((cut) => {
      const bin = cut.binId || cut.binGroup || "";
      const key = [
        cut.workOrder || "",
        cut.furniture || "",
        cut.sku || "",
        cut.partName || "",
        cut.cutLength || 0,
        bin,
      ].join("||");

      if (!groups.has(key)) {
        groups.set(key, {
          key,
          cutNumbers: [],
          workOrder: cut.workOrder || "",
          furniture: cut.furniture || "",
          sku: cut.sku || "",
          partName: cut.partName || "",
          cutLength: cut.cutLength || 0,
          quantity: 0,
          bin,
        });
      }

      const group = groups.get(key);
      group.cutNumbers.push(cut.cutNumber);
      group.quantity += Number(cut.quantity || 1);
    });

    return Array.from(groups.values()).map((group) => ({
      ...group,
      cutNumberLabel: formatCutNumberLabel(group.cutNumbers),
    }));
  };

  const optimizerFurnitureColorFamilies = [
    { hue: 213 },
    { hue: 154 },
    { hue: 32 },
    { hue: 266 },
    { hue: 342 },
    { hue: 185 },
    { hue: 48 },
    { hue: 228 },
  ];

  const optimizerPartToneSteps = [
    { saturation: 92, lightness: 42 },
    { saturation: 78, lightness: 25 },
    { saturation: 96, lightness: 58 },
    { saturation: 58, lightness: 36 },
    { saturation: 88, lightness: 68 },
    { saturation: 68, lightness: 48 },
    { saturation: 100, lightness: 34 },
    { saturation: 72, lightness: 62 },
  ];

  const hashOptimizerKey = (value, modulo) => {
    const text = String(value || "");
    let hash = 0;

    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) % modulo;
    }

    return Math.abs(hash) % modulo;
  };

  const getFurnitureColorFamily = (cut) => {
    const furnitureName = cut.furniture || cut.workOrder || "Furniture";
    const planFurniture = Array.from(
      new Set(
        (materialCutPlan?.groups || []).flatMap((group) =>
          group.pieces.flatMap((piece) =>
            piece.cuts.map((pieceCut) => pieceCut.furniture || pieceCut.workOrder || "Furniture")
          )
        )
      )
    );
    const planIndex = planFurniture.indexOf(furnitureName);
    const fallbackIndex = hashOptimizerKey(furnitureName, optimizerFurnitureColorFamilies.length);

    return optimizerFurnitureColorFamilies[
      (planIndex === -1 ? fallbackIndex : planIndex) % optimizerFurnitureColorFamilies.length
    ];
  };

  const getCutColor = (cut) => {
    const family = getFurnitureColorFamily(cut);
    const tone = optimizerPartToneSteps[
      hashOptimizerKey(`${cut.furniture || ""}|${cut.partName || ""}|${cut.cutLength || 0}`, optimizerPartToneSteps.length)
    ];

    return `hsl(${family.hue}, ${tone.saturation}%, ${tone.lightness}%)`;
  };

  const getCutLegend = (cuts) => {
    const legend = new Map();

    (Array.isArray(cuts) ? cuts : []).forEach((cut) => {
      const key = `${cut.partName || ""}|${cut.cutLength || 0}|${cut.materialType || ""}`;
      if (!legend.has(key)) {
        legend.set(key, {
          key,
          color: getCutColor(cut),
          furniture: cut.furniture || "Furniture",
          partName: cut.partName || "Part",
          cutLength: cut.cutLength || 0,
        });
      }
    });

    return Array.from(legend.values());
  };

  const getCutSegmentClass = (cut) => {
    const length = Number(cut.cutLength || 0);
    if (length > 20) return "large";
    if (length >= 12) return "medium";
    return "small";
  };

  const getCutSegmentLabel = (cut) => {
    return `${formatOptimizerInches(cut.cutLength)} in`;
  };

  const getMaterialLossBreakdown = (pieces, totalLoss) => {
    const sawKerf = (Array.isArray(pieces) ? pieces : []).reduce(
      (sum, piece) => sum + Number(piece.kerfLoss || 0),
      0
    );
    const total = Number(totalLoss || 0);

    return {
      physicalScrap: Math.max(0, total - sawKerf),
      sawKerf,
      total,
    };
  };

  const getReusableDropBreakdown = (pieces, totalDrops) => {
    const drops = (Array.isArray(pieces) ? pieces : [])
      .filter((piece) => Number(piece.reusableDrop || 0) > 0)
      .map((piece, index) => ({
        id: `raw-piece-${piece.rawNumber}-${piece.reusableDrop}-${index}`,
        label: `Material: ${piece.materialType || "Unknown"}`,
        length: Number(piece.reusableDrop || 0),
      }));

    return {
      drops,
      total: Number(totalDrops || 0),
    };
  };

  const getReusableDropCount = (pieces) =>
    (Array.isArray(pieces) ? pieces : []).filter((piece) => Number(piece.reusableDrop || 0) > 0).length;

  const getPiecesWithMaterial = (group) => {
    return (group?.pieces || []).map((piece) => ({
      ...piece,
      materialType: piece.materialType || group.materialType,
    }));
  };

  const MaterialLossTooltip = ({ breakdown }) => (
    <span className="optimizer-loss-tooltip-wrap">
      <button className="optimizer-info-button" type="button" aria-label="Material loss details">
        ⓘ
      </button>
      <span className="optimizer-loss-tooltip optimizer-reusable-tooltip" role="tooltip">
        <b>Material Loss</b>
        <span><em>Physical Scrap</em><strong>{formatOptimizerInches(breakdown.physicalScrap)} in</strong></span>
        <span><em>Saw Kerf</em><strong>{formatOptimizerInches(breakdown.sawKerf)} in</strong></span>
        <i />
        <span><em>Total Loss</em><strong>{formatOptimizerInches(breakdown.total)} in</strong></span>
      </span>
    </span>
  );

  const ReusableDropsTooltip = ({ breakdown }) => (
    <span className="optimizer-loss-tooltip-wrap">
      <button className="optimizer-info-button" type="button" aria-label="Reusable drops details">
        i
      </button>
      <span className="optimizer-loss-tooltip" role="tooltip">
        <b>Reusable Drops</b>
        {breakdown.drops.length === 0 ? (
          <span><em>No reusable drops</em><strong>0 in</strong></span>
        ) : (
          breakdown.drops.map((drop) => (
            <span key={drop.id}><em>{drop.label}</em><strong>{formatOptimizerInches(drop.length)} in</strong></span>
          ))
        )}
        <i />
        <span><em>Total</em><strong>{formatOptimizerInches(breakdown.total)} in</strong></span>
      </span>
    </span>
  );

  const MaterialInventoryPage = () => {
    const rawStockTotal = rawStockInventory.reduce((sum, item) => sum + Number(item.quantityOnHand || 0), 0);
    const availableDrops = reusableDropInventory.filter((drop) => drop.status === "Available");
    const reservedDrops = reusableDropInventory.filter((drop) => drop.status === "Reserved");
    const visibleReusableDrops = reusableDropInventory.filter(
      (drop) => !["Used", "Scrapped"].includes(String(drop.status || "Available"))
    );

    return (
      <section className="enterprise-page material-inventory-page">
        <div className="enterprise-hero-card material-optimizer-hero">
          <div>
            <span className="eyebrow">Developer Inventory</span>
            <h1>Material Inventory</h1>
            <p>Source of truth for raw stock and reusable drops used by future inventory-aware optimization.</p>
          </div>
          <div className="material-optimizer-status">
            <b>{rawStockInventory.length + reusableDropInventory.length}</b>
            <span>Inventory records</span>
          </div>
        </div>

        <div className="optimizer-summary-grid inventory-summary-grid">
          <div className="analytics-kpi-card"><span>Raw Materials</span><b>{rawStockInventory.length}</b><small>{rawStockTotal} pieces on hand</small></div>
          <div className="analytics-kpi-card"><span>Reusable Drops</span><b>{reusableDropInventory.length}</b><small>{availableDrops.length} available</small></div>
          <div className="analytics-kpi-card"><span>Reserved Drops</span><b>{reservedDrops.length}</b><small>future release workflow</small></div>
        </div>

        <div className="enterprise-card inventory-card">
          <div className="inventory-section-head">
            <div>
              <h2><Package size={20} />Raw Stock Inventory</h2>
              <p className="muted">Full-length material pieces available before purchasing.</p>
            </div>
            <button onClick={saveRawStockItem}><Plus size={18} />{editingRawStockId ? "Update Material" : "Add Material"}</button>
          </div>

          <div className="inventory-form-grid">
            <input placeholder="Material Type (2.5 x 1.25)" value={rawStockForm.materialType} onChange={(e) => setRawStockForm({ ...rawStockForm, materialType: e.target.value })} />
            <input type="number" placeholder="Stock Length" value={rawStockForm.stockLength} onChange={(e) => setRawStockForm({ ...rawStockForm, stockLength: e.target.value })} />
            <input type="number" placeholder="Qty On Hand" value={rawStockForm.quantityOnHand} onChange={(e) => setRawStockForm({ ...rawStockForm, quantityOnHand: e.target.value })} />
            <input placeholder="Notes" value={rawStockForm.notes} onChange={(e) => setRawStockForm({ ...rawStockForm, notes: e.target.value })} />
          </div>

          <div className="inventory-table">
            <div className="inventory-row inventory-header">
              <span>Material</span><span>Length</span><span>On Hand</span><span>Notes</span><span>Actions</span>
            </div>
            {rawStockInventory.length === 0 ? (
              <div className="empty small">No raw stock inventory yet.</div>
            ) : rawStockInventory.map((item) => (
              <div key={item.id} className="inventory-row">
                <span>{item.materialType}</span>
                <span>{item.stockLength || 240} in</span>
                <span className={Number(item.quantityOnHand || 0) < 10 ? "inventory-low-quantity" : ""}>{item.quantityOnHand || 0}</span>
                <span>{item.notes || "-"}</span>
                <span className="inventory-actions"><button onClick={() => editRawStockItem(item)}><Pencil size={18} />Edit</button><button className="danger" onClick={() => deleteRawStockItem(item.id)}><Trash2 size={18} />Delete</button></span>
              </div>
            ))}
          </div>
        </div>

        <div className="enterprise-card inventory-card">
          <div className="inventory-section-head">
            <div>
              <h2><Recycle size={20} />Reusable Drops Inventory</h2>
              <p className="muted">Shorter saved drops that should be consumed before new raw stock in future plans.</p>
            </div>
            <button onClick={saveReusableDropItem}><PlusCircle size={18} />{editingReusableDropId ? "Update Drop" : "Add Drop"}</button>
          </div>

          <div className="inventory-form-grid">
            <input placeholder="Material Type" value={reusableDropForm.materialType} onChange={(e) => setReusableDropForm({ ...reusableDropForm, materialType: e.target.value })} />
            <input type="number" placeholder="Length" value={reusableDropForm.length} onChange={(e) => setReusableDropForm({ ...reusableDropForm, length: e.target.value })} />
            <input type="date" value={reusableDropForm.createdDate} onChange={(e) => setReusableDropForm({ ...reusableDropForm, createdDate: e.target.value })} />
            <select value={reusableDropForm.status} onChange={(e) => setReusableDropForm({ ...reusableDropForm, status: e.target.value })}>{REUSABLE_DROP_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
            <input placeholder="Notes" value={reusableDropForm.notes} onChange={(e) => setReusableDropForm({ ...reusableDropForm, notes: e.target.value })} />
          </div>

          <div className="inventory-table reusable-drop-table">
            <div className="inventory-row inventory-header">
              <span>Material</span><span>Length</span><span>Date</span><span>Status</span><span>Notes</span><span>Actions</span>
            </div>
            {visibleReusableDrops.length === 0 ? (
              <div className="empty small">No reusable drops saved yet.</div>
            ) : visibleReusableDrops.map((item) => (
              <div key={item.id} className="inventory-row">
                <span className="inventory-drop-primary">{item.materialType}</span>
                <span className="inventory-drop-primary">{item.length || 0} in</span>
                <span>{item.createdDate || "-"}</span>
                <span>{item.status || "Available"}</span>
                <span>{item.notes || "-"}</span>
                <span className="inventory-actions">
                  <button onClick={() => editReusableDropItem(item)}><Pencil size={18} />Edit</button>
                  <button onClick={() => updateReusableDropStatus(item.id, "Used")}><Check size={18} />Mark Used</button>
                  <button onClick={() => updateReusableDropStatus(item.id, "Scrapped")}><Trash2 size={18} />Mark Scrap</button>
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  };

  const renderMaterialOptimizerPage = () => {
    const optimizerJobs = getMaterialOptimizerJobs();
    const modeDetails = MATERIAL_OPTIMIZER_MODES[materialOptimizerMode];
    const sourceLabels = {
      currentWeek: `Current Week (${scheduleWeeks[selectedScheduleWeek] || `Week ${selectedScheduleWeek + 1}`})`,
      selectedJobs: "Selected Jobs",
      allScheduled: "All Scheduled",
    };
    const projectedImpact = materialCutPlan?.projectedInventoryImpact;
    const getImpactStockLength = (materialType) =>
      materialCutPlan?.groups?.find((group) => group.materialType === materialType)?.stockLength || 240;
    const rawStockUsedPieces = projectedImpact?.rawStockUsed.reduce((sum, row) => sum + Number(row.projectedPiecesUsed || 0), 0) || 0;
    const rawStockUsedLength = projectedImpact?.rawStockUsed.reduce(
      (sum, row) => sum + Number(row.projectedPiecesUsed || 0) * getImpactStockLength(row.materialType),
      0
    ) || 0;
    const projectedRawStockRemainingPieces = projectedImpact?.rawStockUsed.reduce((sum, row) => sum + Number(row.projectedRemaining || 0), 0) || 0;
    const projectedRawStockRemainingLength = projectedImpact?.rawStockUsed.reduce(
      (sum, row) => sum + Number(row.projectedRemaining || 0) * getImpactStockLength(row.materialType),
      0
    ) || 0;
    const reusableDropsUsedLength = projectedImpact?.reusableDropsUsed.reduce((sum, drop) => sum + Number(drop.cutLength || 0), 0) || 0;
    const newReusableDropsLength = projectedImpact?.newReusableDrops.reduce((sum, drop) => sum + Number(drop.length || 0), 0) || 0;
    const materialCutPlanPieces = materialCutPlan?.groups?.flatMap((group) => getPiecesWithMaterial(group)) || [];
    const reusableDropPieceCount = getReusableDropCount(materialCutPlanPieces);

    return (
      <section className="enterprise-page material-optimizer-page">
        <div className="enterprise-hero-card material-optimizer-hero">
          <div>
            <span className="eyebrow">Developer Preview</span>
            <h1>Material Optimizer</h1>
            <p>First-step fabrication planning for cut layouts, reusable drops, purchasing forecasts, printable sheets, and bins.</p>
          </div>
          <div className="material-optimizer-status">
            <b>{optimizerJobs.length}</b>
            <span>Selected jobs</span>
          </div>
        </div>

        <div className="enterprise-card material-optimizer-controls">
          <div>
            <h2>Optimization Mode</h2>
            <p className="muted">{modeDetails.description}</p>
          </div>

          <div className="optimizer-control-grid">
            <div className="optimizer-mode-selector">
              {Object.entries(MATERIAL_OPTIMIZER_MODES).map(([modeKey, mode]) => (
                <button
                  key={modeKey}
                  className={materialOptimizerMode === modeKey ? "optimizer-mode active" : "optimizer-mode"}
                  onClick={() => setMaterialOptimizerMode(modeKey)}
                >
                  <b>{mode.label}</b>
                  <span>{mode.description}</span>
                </button>
              ))}
            </div>

            <label className="optimizer-source-control">
              <span>Schedule Source</span>
              <select
                value={materialOptimizerSource}
                onChange={(e) => setMaterialOptimizerSource(e.target.value)}
              >
                <option value="currentWeek">Current Week</option>
                <option value="selectedJobs">Selected Jobs</option>
                <option value="allScheduled">All Scheduled</option>
              </select>
            </label>

            <label className="optimizer-source-control">
              <span>Reusable Drop Threshold</span>
              <input
                type="number"
                min="0"
                step="0.25"
                value={reusableDropThreshold}
                onChange={(e) => setReusableDropThreshold(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>

            <label className="optimizer-source-control">
              <span>Saw Kerf</span>
              <input
                type="number"
                min="0"
                step="0.001"
                value={optimizerKerf}
                onChange={(e) => setOptimizerKerf(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>

            <button
              className="optimizer-generate-button"
              onClick={generateMaterialCutPlan}
              disabled={optimizerJobs.length === 0}
            >
              <Scissors size={18} />
              Generate Cut Plan
            </button>
          </div>

          <div className="note optimizer-note">
            Preview only &mdash; inventory is not updated until Commit Material Plan.
          </div>
        </div>

        {optimizerJobs.length === 0 ? (
          <div className="empty material-optimizer-empty">
            Scheduled jobs are needed to generate a cut plan for {sourceLabels[materialOptimizerSource]}.
          </div>
        ) : !materialCutPlan ? (
          <div className="empty material-optimizer-empty">
            Choose a mode and generate a preview cut plan. No schedule data will be changed.
          </div>
        ) : materialCutPlan.totalParts === 0 ? (
          <div className="empty material-optimizer-empty">
            The selected jobs do not have saved model parts yet. Add parts to the furniture model, then generate again.
          </div>
        ) : (
          <>
            <div className="optimizer-summary-grid">
              <div className="analytics-kpi-card"><span>Selected Jobs</span><b>{materialCutPlan.selectedJobs}</b><small>{sourceLabels[materialCutPlan.source]}</small></div>
              <div className="analytics-kpi-card"><span>Total Parts</span><b>{materialCutPlan.totalParts}</b><small>individual cuts</small></div>
              <div className="analytics-kpi-card"><span>Material Types</span><b>{materialCutPlan.materialTypes}</b><small>separate layouts</small></div>
              <div className="analytics-kpi-card">
                <span className="optimizer-kpi-label">
                  Raw Pieces Required
                  <button
                    className="optimizer-info-button"
                    type="button"
                    aria-label="Open printable schedule cut plan"
                    onClick={() => setScheduleCutPlanOpen(true)}
                  >
                    i
                  </button>
                </span>
                <b>{materialCutPlan.rawPiecesRequired}</b>
                <small>240 in stock</small>
              </div>
              <div className="analytics-kpi-card"><span>Estimated Saved</span><b>{formatOptimizerInches(materialCutPlan.estimatedSaved)}</b><small>inches vs standard</small></div>
              <div className="analytics-kpi-card">
                <span className="optimizer-kpi-label">
                  Reusable Drops
                  <ReusableDropsTooltip
                    breakdown={getReusableDropBreakdown(
                      materialCutPlanPieces,
                      materialCutPlan.reusableDrops
                    )}
                  />
                </span>
                <b>{reusableDropPieceCount}</b>
                <small>{formatOptimizerInches(materialCutPlan.settings?.reusableDropThreshold ?? reusableDropThreshold)} in or larger</small>
              </div>
              <div className="analytics-kpi-card">
                <span className="optimizer-kpi-label">
                  Material Loss
                  <MaterialLossTooltip
                    breakdown={getMaterialLossBreakdown(
                      materialCutPlan.groups.flatMap((group) => group.pieces),
                      materialCutPlan.scrap
                    )}
                  />
                </span>
                <b>{formatOptimizerInches(materialCutPlan.scrap)}</b>
              </div>
            </div>

            <div className="optimizer-command-center">
            {projectedImpact && (
              <div className="enterprise-card inventory-impact-card optimizer-inventory-side-panel">
                <div className="inventory-section-head">
                  <div>
                    <h2>Projected Inventory Impact</h2>
                  </div>
                </div>

                <div className="optimizer-impact-list">
                  <div className="optimizer-impact-row">
                    <span>Raw Stock Used</span>
                    <b className="impact-good">{rawStockUsedPieces} piece{rawStockUsedPieces === 1 ? "" : "s"} ({formatOptimizerInches(rawStockUsedLength)} in)</b>
                  </div>
                  <div className="optimizer-impact-row">
                    <span>Reusable Drops Used</span>
                    <b className="impact-good">{formatOptimizerInches(reusableDropsUsedLength)} in ({projectedImpact.reusableDropsUsed.length} drop{projectedImpact.reusableDropsUsed.length === 1 ? "" : "s"})</b>
                  </div>
                  <div className="optimizer-impact-row">
                    <span>New Reusable Drops Created</span>
                    <b className="impact-good">{formatOptimizerInches(newReusableDropsLength)} in ({projectedImpact.newReusableDrops.length} drop{projectedImpact.newReusableDrops.length === 1 ? "" : "s"})</b>
                  </div>
                  <div className="optimizer-impact-row">
                    <span>Material Loss</span>
                    <b className="impact-loss">{formatOptimizerInches(projectedImpact.materialLoss)} in</b>
                  </div>
                  <div className="optimizer-impact-row">
                    <span>Raw Stock Remaining</span>
                    <b className="impact-good">{projectedRawStockRemainingPieces} piece{projectedRawStockRemainingPieces === 1 ? "" : "s"} ({formatOptimizerInches(projectedRawStockRemainingLength)} in)</b>
                  </div>
                </div>

                <div className="inventory-impact-columns optimizer-impact-detail">
                  <div>
                    <h3>Projected Raw Stock</h3>
                    {projectedImpact.rawStockUsed.length === 0 ? (
                      <div className="empty small">No raw stock projection yet.</div>
                    ) : projectedImpact.rawStockUsed.map((row) => (
                      <p key={row.materialType}><b>{row.materialType}</b> — {row.projectedPiecesUsed} used / {row.projectedRemaining} projected remaining</p>
                    ))}
                  </div>
                  {projectedImpact.shortages.length > 0 && (
                  <div className="optimizer-impact-shortage">
                    <h3>Shortages</h3>
                    {projectedImpact.shortages.map((shortage) => (
                      <p key={shortage.materialType}><b>{shortage.materialType}</b> — short {shortage.shortagePieces} piece{shortage.shortagePieces === 1 ? "" : "s"}</p>
                    ))}
                  </div>
                  )}
                </div>

                <div className="optimizer-impact-footer">
                  <p>Preview only &mdash; inventory is not updated until Commit Material Plan.</p>
                  <div className="optimizer-commit-actions">
                    <button
                      type="button"
                      className="optimizer-commit-button"
                      onClick={commitMaterialPlan}
                      disabled={Boolean(materialCutPlan.inventoryCommittedAt)}
                    >
                      <CheckCheck size={18} />
                      {materialCutPlan.inventoryCommittedAt ? "Material Plan Committed" : "Commit Material Plan"}
                    </button>
                    <span>Deliberate approval step. Preview generation never changes inventory.</span>
                  </div>
                </div>
              </div>
            )}

            <div className="optimizer-command-main">
            <div className="enterprise-card optimizer-bins-card">
              <h2>Cut Part Bins</h2>
              <p className="muted">
                Bins tell the saw operator where each cut part should go after cutting. Even when multiple jobs share the same raw material stick, each job/furniture stays in its own labeled bin.
              </p>
              {(materialCutPlan.fabricationBins || materialCutPlan.bins).length === 0 ? (
                <div className="empty small">No bins generated yet.</div>
              ) : (
                <div className="optimizer-bin-grid">
                  {(materialCutPlan.fabricationBins || materialCutPlan.bins).map((bin) => (
                    <div key={bin.key} className="optimizer-bin-label">
                      <b>{bin.label}</b>
                      <span>Work Order: {bin.sku || "-"}</span>
                      <span>Furniture: {bin.furniture || "-"}</span>
                      <span>Material: {bin.materialType || "-"}</span>
                      <small>{bin.cutCount || 0} cuts {bin.binId ? ` / ${bin.binId}` : ""}</small>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="optimizer-material-list">
              {materialCutPlan.groups.map((group) => {
                const lossBreakdown = getMaterialLossBreakdown(group.pieces, group.scrap);

                return (
                <div key={group.materialType} className="enterprise-card optimizer-material-card">
                  <div className="optimizer-material-head">
                    <div>
                      <h2>{group.materialType}</h2>
                      <p className="muted">Raw stock length: {group.stockLength} in</p>
                    </div>
                    <div className="optimizer-material-stats">
                      <span><b>{group.totalCuts}</b> total cuts</span>
                      <span><b>{group.pieces.length}</b> raw pieces</span>
                      <span>
                        <b>{formatOptimizerInches(group.reusableDrops)}</b>
                        <span className="optimizer-loss-label">
                          <Recycle size={18} />
                          Reusable Drops
                          <ReusableDropsTooltip breakdown={getReusableDropBreakdown(getPiecesWithMaterial(group), group.reusableDrops)} />
                        </span>
                      </span>
                      <span>
                        <b>{formatOptimizerInches(group.scrap)}</b>
                        <span className="optimizer-loss-label">
                          <TriangleAlert size={18} />
                          Material Loss
                          <MaterialLossTooltip breakdown={lossBreakdown} />
                        </span>
                      </span>
                    </div>
                  </div>

                  <div className="optimizer-piece-list">
                    {group.pieces.map((piece) => {
                      const usedLength = piece.stockLength - piece.remaining;
                      const cutLegend = getCutLegend(piece.cuts);
                      const pieceKey = getOptimizerPieceKey(group.materialType, piece.rawNumber);
                      const isPieceExpanded = Boolean(expandedOptimizerPieces[pieceKey]);

                      return (
                        <div
                          key={`${group.materialType}-${piece.rawNumber}`}
                          className={isPieceExpanded ? "optimizer-piece-card expanded" : "optimizer-piece-card"}
                        >
                          <button
                            type="button"
                            className="optimizer-piece-title"
                            onClick={() => toggleOptimizerPiece(pieceKey)}
                            aria-expanded={isPieceExpanded}
                          >
                            <b>
                              <span className="optimizer-piece-caret">{isPieceExpanded ? "▾" : "▸"}</span>
                              Raw Piece #{piece.rawNumber} - {piece.stockLength} in
                            </b>
                            <span>
                              {formatOptimizerInches(usedLength)} in used / {formatOptimizerInches(piece.remaining)} in remaining
                            </span>
                          </button>

                          {cutLegend.length > 0 && (
                            <div className="optimizer-cut-legend">
                              {cutLegend.map((item) => (
                                <span key={item.key}>
                                  <i style={{ background: item.color }} />
                                  {item.furniture} / {item.partName} / {formatOptimizerInches(item.cutLength)} in
                                </span>
                              ))}
                            </div>
                          )}

                          <div className="optimizer-cut-bar">
                            {piece.cuts.map((cut) => (
                              <span
                                key={cut.id}
                                className={`optimizer-cut-segment optimizer-cut-segment-${getCutSegmentClass(cut)}`}
                                style={{
                                  width: `${Math.max(2, (cut.cutLength / piece.stockLength) * 100)}%`,
                                  background: getCutColor(cut),
                                }}
                                title={`${cut.partName} - ${formatOptimizerInches(cut.cutLength)} in`}
                              >
                                <span className="optimizer-cut-segment-text">
                                  {getCutSegmentLabel(cut)}
                                </span>
                              </span>
                            ))}
                            {piece.remaining > 0 && (
                              <span
                                className={piece.reusableDrop ? "optimizer-drop-segment reusable" : "optimizer-drop-segment"}
                                style={{
                                  width: `${Math.max(2, (piece.remaining / piece.stockLength) * 100)}%`,
                                }}
                                title={`${formatOptimizerInches(piece.remaining)} in remaining`}
                              />
                            )}
                          </div>

                          {isPieceExpanded && (
                            <div className="optimizer-cut-table">
                              <div className="optimizer-cut-row optimizer-cut-header">
                                <span>Cut #</span>
                                <span>Work Order</span>
                                <span>Furniture</span>
                                <span>SKU</span>
                                <span>Part</span>
                                <span>Length</span>
                                <span>Qty</span>
                                <span>Bin</span>
                              </div>

                              {groupCutsForDisplay(piece.cuts).map((cutGroup) => (
                                <div key={`${cutGroup.key}-row`} className="optimizer-cut-row">
                                  <span>{cutGroup.cutNumberLabel}</span>
                                  <span>{cutGroup.workOrder}</span>
                                  <span>{cutGroup.furniture}</span>
                                  <span>{cutGroup.sku || "-"}</span>
                                  <span>{cutGroup.partName}</span>
                                  <span>{formatOptimizerInches(cutGroup.cutLength)} in</span>
                                  <span>{cutGroup.quantity}</span>
                                  <span>{cutGroup.bin}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
            </div>
            </div>
          </>
        )}
      </section>
    );
  };

  const renderProductionDashboard = () => {
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

    const activeJobs = activeLiveJobs;
    const dashboardMessages = shopMessages.slice(0, 4);
    const topJobs = activeJobs.slice(0, 5);
    const selectedDashboardStageIndex = STAGES.indexOf(dashboardDepartment);
    const selectedDashboardJobs =
      selectedDashboardStageIndex === -1 ? [] : liveForStage(selectedDashboardStageIndex);
    const selectedDashboardQty = selectedDashboardJobs.reduce(
      (sum, job) => sum + Number(job.qty || 0),
      0
    );
    const recentActivity = [
      ...activeJobs.slice(0, 4).map((job) => ({
        id: `live-${job.id}`,
        title: `${job.collection || "Job"} ${job.furniture || ""}`.trim(),
        detail: `Active in ${STAGES[job.stage] || "Production"}`,
        badge: (job.furniture || job.collection || "J").slice(0, 1).toUpperCase(),
        time: job.startedAt ? formatMessageTime(job.startedAt) : "Live now",
      })),
      ...dashboardMessages.slice(0, 2).map((message) => ({
        id: `msg-${message.id}`,
        title: `From: ${getMessageSenderLabel(message)}`,
        detail: `To: ${getMessageRecipientLabel(message)} \u00b7 ${message.message || "New message"}`,
        badge: getMessageSenderLabel(message).slice(0, 1).toUpperCase(),
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
            <span>{currentRole} Dashboard</span>
          </div>

          <LiveDashboardClock />
        </header>

        <div className="tv-dashboard-grid">
          <section className="tv-panel tv-summary-panel">
            <h3>Today&apos;s Summary</h3>

            <div className="tv-summary-list">
              <div>
                <span>Scheduled Jobs</span>
                <b><AnimatedNumber value={selectedWeekJobMetrics.scheduledJobs} /></b>
              </div>
              <div>
                <span>Active Jobs</span>
                <b><AnimatedNumber value={selectedWeekJobMetrics.activeJobs} /></b>
              </div>
              <div>
                <span>Completed</span>
                <b><AnimatedNumber value={selectedWeekJobMetrics.completedJobs} /></b>
              </div>
              <div>
                <span>Delayed / Hold</span>
                <b><AnimatedNumber value={selectedWeekJobMetrics.delayedJobs} /></b>
              </div>
              <div>
                <span>Messages</span>
                <b><AnimatedNumber value={shopMessages.length} /></b>
              </div>
            </div>
          </section>

          <section className="tv-panel tv-flow-panel">
            <div className="tv-production-flow-section">
              <h3>Production Flow</h3>

              <div className="tv-flow-row">
                {stageCards.map((item, index) => (
                  <button
                    key={item.stage}
                    type="button"
                    className={`tv-stage-card tv-stage-${stageSlug(item.stage)} ${
                      dashboardDepartment === item.stage ? "selected" : ""
                    }`}
                    onClick={() => setDashboardDepartment(item.stage)}
                    title={`Show ${item.stage} jobs`}
                  >
                    <span>{item.stage}</span>
                    <b><AnimatedNumber value={item.count} /></b>
                    <small><AnimatedNumber value={item.qty} /> Qty</small>
                    <em>{item.delayedCount} Delayed</em>
                    {index < stageCards.length - 1 && <i aria-hidden="true">→</i>}
                  </button>
                ))}
              </div>
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
                  <article
                    key={activity.id}
                    className={String(activity.id || "").startsWith("job-") && recentlyMovedJobIds.includes(String(activity.id).replace("job-", "")) ? "tv-activity-pulse" : ""}
                  >
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
                  const { percent } = getDashboardJobProgress(job);
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

          <section className="tv-panel tv-table-panel tv-dept-jobs-panel">
            <div className="tv-panel-title-row">
              <div>
                <h3>{dashboardDepartment} Jobs</h3>
                <p>{selectedDashboardJobs.length} active job{selectedDashboardJobs.length === 1 ? "" : "s"} • <AnimatedNumber value={selectedDashboardQty} /> qty</p>
              </div>
              <span className={`stage-badge stage-${stageSlug(dashboardDepartment)}`}>
                {dashboardDepartment}
              </span>
            </div>

            {selectedDashboardJobs.length === 0 ? (
              <div className="tv-empty">No active jobs in {dashboardDepartment} right now.</div>
            ) : (
              <div className="tv-selected-job-list">
                {selectedDashboardJobs.map((job) => {
                  const { completed, total, percent } = getDashboardJobProgress(job);

                  return (
                    <article
                      key={job.id}
                      className={recentlyMovedJobIds.includes(job.id) ? "tv-job-moved-pulse" : ""}
                    >
                      <div className="tv-selected-job-main">
                        <span className="tv-selected-job-sku">{job.sku || job.specs?.sku || "NO SKU"}</span>
                        <b>{job.furniture}</b>
                        <small>
                          Qty {job.qty || 0}
                          {job.dueDate ? ` • Due ${job.dueDate}` : ""}
                        </small>
                      </div>

                      <div className="tv-selected-job-progress">
                        <div>
                          <span>Progress <small>· {completed} of {total}</small></span>
                          <b>{Math.min(100, percent)}%</b>
                        </div>
                        <div className="tv-mini-progress">
                          <i style={{ width: `${Math.min(100, percent)}%` }} />
                        </div>
                      </div>
                    </article>
                  );
                })}
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
                    <span className="tv-message-context">
                      From: {getMessageSenderLabel(message)}
                      <small>To: {getMessageRecipientLabel(message)}</small>
                    </span>
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
              {renderNavIcon(navItem)}
              {navItem}
            </button>
          ))}

          {["Developer", "Admin"].includes(currentRole) && (
            <button
              className={`main-nav-button nav-fishbowl ${view === "Fishbowl" ? "active-nav" : ""}`}
              onClick={() => setView("Fishbowl")}
            >
              {renderNavIcon("Fishbowl")}
              Fishbowl
            </button>
          )}

          {currentRole === "Developer" && (
            <>
              <button
                className={`main-nav-button nav-analytics ${view === "Analytics" ? "active-nav" : ""}`}
                onClick={() => setView("Analytics")}
              >
                {renderNavIcon("Analytics")}
                Analytics
              </button>

              <button
                className={`main-nav-button nav-material-optimizer ${view === "Material Optimizer" ? "active-nav" : ""}`}
                onClick={() => setView("Material Optimizer")}
              >
                {renderNavIcon("Material Optimizer")}
                Material Optimizer
              </button>

              <button
                className={`main-nav-button nav-material-inventory ${view === "Material Inventory" ? "active-nav" : ""}`}
                onClick={() => setView("Material Inventory")}
              >
                {renderNavIcon("Material Inventory")}
                Material Inventory
              </button>
            </>
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

      {!isEmployeeMode && view === "Live" && (
        <div className="stats-row">
          <div className="stat-card">
            <span>Scheduled Jobs</span>
            <b>{dashboard.scheduledJobs}</b>
          </div>

          <div className="stat-card">
            <span>Scheduled Qty</span>
            <b><AnimatedNumber value={dashboard.scheduledQty} /></b>
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
        {view === "Dashboard" && renderProductionDashboard()}

        {view === "Fishbowl" && renderFishbowlConnectionPage()}

        {view === "Analytics" && currentRole === "Developer" && renderDeveloperAnalyticsPage()}

        {view === "Material Optimizer" && currentRole === "Developer" && renderMaterialOptimizerPage()}

        {view === "Material Inventory" && currentRole === "Developer" && MaterialInventoryPage()}

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
                <div className="hero model-library-hero">
                  <h1>Select or create a collection</h1>
                  <p>
                    Collections hold furniture pieces. Each furniture piece can
                    have a saved parts list, image, and schedule jobs.
                  </p>
                </div>
              ) : (
                <>
                  <div className="page-head model-library-hero">
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
                              <p className="muted model-saved-parts">
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

                          <div className="furniture-action-bar">
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
                                className="model-view-cut-sheet-button"
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

                  {canManage && (
                    <div className="card add-furniture-type-card">
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
                    Live communication between departments, supervisors, and production staff.
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

                  <button
                    className="wide message-send-button"
                    type="submit"
                    disabled={shopMessageSending || !shopMessageText.trim()}
                  >
                    {shopMessageSending ? "Sending..." : "Send Message"}
                  </button>
                </form>

                <section className="card message-feed-card">
                  <div className="message-feed-head">
                    <h2>Recent Shop Notes</h2>
                    <span>{shopMessages.length} shown</span>
                  </div>

                  {shopMessageDeleteError && (
                    <div className="message-delete-error" role="alert">
                      {shopMessageDeleteError}
                    </div>
                  )}

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
                            <button
                              type="button"
                              className="message-photo-link message-photo-open-button"
                              onClick={() => openShopMessageAttachment(message)}
                              title="Open attachment"
                            >
                              <img src={message.attachment_url} alt={message.attachment_name || "Shop note attachment"} />
                            </button>
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

                          {canDeleteShopMessages && (
                            <button
                              type="button"
                              className="danger message-delete-button"
                              onClick={() => deleteShopMessage(message.id)}
                              disabled={Boolean(shopMessageDeletingId)}
                              aria-busy={shopMessageDeletingId === message.id}
                            >
                              {shopMessageDeletingId === message.id
                                ? "Deleting..."
                                : "Delete"}
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
                        Review work orders, adjust quantities, and release jobs into production.
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
                            <b><AnimatedNumber value={activeJobs.length} /></b>
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
                                  <span className="schedule-card-status-pill">{job.status}</span>
                                  <div className="schedule-qty-controls">
                                    <b>Qty:</b>
                                    <button onClick={() => adjustScheduleQty(job.id, -1)}>
                                      -
                                    </button>
                                    <span>{job.qtyNeeded}</span>
                                    <button onClick={() => adjustScheduleQty(job.id, 1)}>
                                      +
                                    </button>
                                  </div>
                                </div>

                                <details className="schedule-timeline">
                                  <summary>Timeline</summary>
                                  <div className="schedule-timeline-list">
                                    {getScheduleTimeline(job).map((event) => (
                                      <div key={event.id} className="schedule-timeline-item">
                                        <span className={`timeline-dot stage-${stageSlug(event.stage)}`} />
                                        <div>
                                          <b>{event.title}</b>
                                          <small>{event.stage} • {formatTimelineTime(event.at)}</small>
                                          {event.note && <p>{event.note}</p>}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </details>

                                <div className="schedule-board-actions">
                                  {canManage && (
                                    <button onClick={() => releaseToProduction(job)}>
                                      Release To Live
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

                                  {!isEmployeeMode && (
                                    <button onClick={() => toggleScheduleComplete(job.id)}>
                                      Check Off
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
                  <div className="page-head live-shop-head">
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
                      <button className="live-clear-completed-button" onClick={() => runLiveActionWithoutJump(clearCompletedLiveJobs)}>
                        <Trash2 size={18} />
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
                            <span className="department-tab-icon"><StageIcon stageName={department} size={20} /></span>
                            <span>
                              <b>{department}</b>
                              <small>{count} jobs</small>
                            </span>
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
                            <span className="department-tab-icon"><StageIcon stageName={panel.stageName || panel.title} size={20} /></span>
                            <span>
                              <b>{panel.title}</b>
                              <small>{panel.jobs.length} jobs</small>
                            </span>
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

      {selectedShopMessageAttachment && (
        <div
          className="cut-sheet-modal-backdrop"
          onClick={() => setSelectedShopMessageAttachment(null)}
        >
          <div
            className="cut-sheet-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="cut-sheet-modal-actions">
              <button
                type="button"
                onClick={() => setSelectedShopMessageAttachment(null)}
              >
                Close
              </button>
            </div>

            <div className="card" style={{ textAlign: "center" }}>
              <h2>{selectedShopMessageAttachment.name}</h2>
              <p className="muted">
                {selectedShopMessageAttachment.from} → {selectedShopMessageAttachment.to}
                {selectedShopMessageAttachment.at
                  ? ` • ${formatMessageTime(selectedShopMessageAttachment.at)}`
                  : ""}
              </p>

              {selectedShopMessageAttachment.message && (
                <p>{selectedShopMessageAttachment.message}</p>
              )}

              <img
                src={selectedShopMessageAttachment.url}
                alt={selectedShopMessageAttachment.name}
                style={{
                  maxWidth: "100%",
                  maxHeight: "75vh",
                  objectFit: "contain",
                  borderRadius: "12px",
                  border: "1px solid #333",
                  background: "#111",
                }}
              />
            </div>
          </div>
        </div>
      )}

      {scheduleCutPlanOpen && materialCutPlan && (
        <div className="cut-sheet-modal-backdrop schedule-cut-plan-backdrop" onClick={() => setScheduleCutPlanOpen(false)}>
          <div className="cut-sheet-modal schedule-cut-plan-modal" onClick={(event) => event.stopPropagation()}>
            <div className="cut-sheet-modal-actions no-print">
              <button type="button" onClick={() => setScheduleCutPlanOpen(false)}>Close</button>
              <button type="button" onClick={printScheduleCutPlan}>Print</button>
            </div>

            <div className="cut-sheet-preview schedule-cut-plan-print">
              <div className="cut-sheet-preview-header schedule-cut-plan-header">
                <div className="schedule-cut-plan-title-block">
                  <h1>Schedule Cut Plan</h1>
                  <h2>Material Optimizer Production Packet</h2>
                </div>

                <div className="schedule-cut-plan-logo-block">
                  <div className="cut-sheet-logo">ADMIRAL</div>
                  <div className="cut-sheet-logo-sub">OUTDOOR</div>
                </div>

                <div className="schedule-cut-plan-meta">
                  <div><b>Generated:</b> {formatGeneratedDate(materialCutPlan.generatedAt)}</div>
                  <div><b>Mode:</b> {MATERIAL_OPTIMIZER_MODES[materialCutPlan.mode]?.label || materialCutPlan.mode}</div>
                  <div><b>Source:</b> {getMaterialOptimizerSourceLabel(materialCutPlan.source)}</div>
                </div>
              </div>

              <div className="schedule-cut-plan-summary">
                <div><span>Total Raw Pieces</span><b>{materialCutPlan.rawPiecesRequired}</b></div>
                <div><span>Total Cuts</span><b>{materialCutPlan.totalParts}</b></div>
                <div><span>Reusable Drops</span><b>{formatOptimizerInches(materialCutPlan.reusableDrops)} in</b></div>
                <div><span>Material Loss</span><b>{formatOptimizerInches(materialCutPlan.scrap)} in</b></div>
              </div>

              <div className="schedule-cut-plan-sections">
                {materialCutPlan.groups.map((group) => (
                  <section key={`print-${group.materialType}`} className="schedule-cut-plan-material">
                    <div className="schedule-cut-plan-material-head">
                      <h2>{group.materialType}</h2>
                      <div>
                        <span>Raw stock length: {group.stockLength} in</span>
                        <span>Raw pieces required: {group.pieces.length}</span>
                      </div>
                    </div>

                    {group.pieces.map((piece) => {
                      const usedLength = piece.stockLength - piece.remaining;
                      const remainderStatus = piece.reusableDrop
                        ? `Reusable drop - ${formatOptimizerInches(piece.reusableDrop)} in`
                        : `Scrap - ${formatOptimizerInches(piece.scrap)} in`;

                      return (
                        <div key={`print-${group.materialType}-${piece.rawNumber}`} className="schedule-cut-plan-piece">
                          <div className="schedule-cut-plan-piece-head">
                            <h3>Raw Material #{piece.rawNumber} - {formatMaterialSizeLabel(group.materialType)}</h3>
                            <div>
                              <span>Used: {formatOptimizerInches(usedLength)} in</span>
                              <span>Remaining: {formatOptimizerInches(piece.remaining)} in</span>
                              <span>{remainderStatus}</span>
                            </div>
                          </div>

                          <table className="schedule-cut-plan-table">
                            <thead>
                              <tr>
                                <th>Cut #</th>
                                <th>SKU / Work Order</th>
                                <th>Furniture</th>
                                <th>Part</th>
                                <th>Length</th>
                                <th>Qty</th>
                                <th>Bin</th>
                              </tr>
                            </thead>
                            <tbody>
                              {groupCutsForDisplay(piece.cuts).map((cutGroup) => (
                                <tr key={`print-${group.materialType}-${piece.rawNumber}-${cutGroup.key}`}>
                                  <td>{cutGroup.cutNumberLabel}</td>
                                  <td>{cutGroup.sku || cutGroup.workOrder || "-"}</td>
                                  <td>{cutGroup.furniture || "-"}</td>
                                  <td>{cutGroup.partName || "-"}</td>
                                  <td>{formatOptimizerInches(cutGroup.cutLength)} in</td>
                                  <td>{cutGroup.quantity}</td>
                                  <td>{cutGroup.bin || "-"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                  </section>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

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
              <div className="cut-sheet-preview-header cut-sheet-product-header">
                <div className="cut-sheet-product-details">
                  <h1>{cutSheetView.type.name}</h1>
                  <h2>{cutSheetView.model.name}</h2>
                  <div className="cut-sheet-meta">
                    <div><b>Total Parts:</b> {cutSheetView.type.parts?.length || 0}</div>
                    <div><b>Generated:</b> {new Date().toLocaleDateString()}</div>
                  </div>
                </div>

                <div className="cut-sheet-product-logo">
                  <div className="cut-sheet-logo">ADMIRAL</div>
                  <div className="cut-sheet-logo-sub">OUTDOOR</div>
                </div>

                {cutSheetView.type.image && (
                  <div className="cut-sheet-preview-image-frame">
                    <img
                      src={cutSheetView.type.image}
                      className="cut-sheet-preview-img"
                      alt=""
                    />
                  </div>
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
