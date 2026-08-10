import test from "node:test";
import assert from "node:assert/strict";

import { resolvePostLoginView } from "./authNavigation.js";

test("elevated roles land on Dashboard after authentication", () => {
  ["Developer", "Admin", "Supervisor"].forEach((role) => {
    assert.equal(
      resolvePostLoginView({ role, dashboardAllowed: true }),
      "Dashboard"
    );
  });
});

test("Employee users continue landing on their saved department Live view", () => {
  assert.equal(
    resolvePostLoginView({
      role: "Employee",
      dashboardAllowed: true,
      employeeDepartment: "Welding",
    }),
    "Welding"
  );
  assert.equal(
    resolvePostLoginView({ role: "Employee", dashboardAllowed: true }),
    "Fabrication"
  );
});

test("elevated roles retain Live as their fallback when Dashboard is unavailable", () => {
  ["Developer", "Admin", "Supervisor"].forEach((role) => {
    assert.equal(
      resolvePostLoginView({ role, dashboardAllowed: false }),
      "Live"
    );
  });
});
