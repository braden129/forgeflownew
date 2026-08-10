const ELEVATED_ROLES = ["Developer", "Admin", "Supervisor"];

export function resolvePostLoginView({ role, dashboardAllowed, employeeDepartment }) {
  if (role === "Employee") return employeeDepartment || "Fabrication";
  if (ELEVATED_ROLES.includes(role) && dashboardAllowed) return "Dashboard";
  return "Live";
}
