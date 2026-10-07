import test from "node:test";
import assert from "node:assert/strict";
import { hasCurrentManagementPermission, managementActionErrorMessage, MANAGEMENT_ACCESS_CHANGED_MESSAGE } from "../src/lib/managementAccess.js";

test("organization owners retain critical action access", () => {
  assert.equal(hasCurrentManagementPermission({ isOrganizationOwner: true }, "schedule.manage"), true);
});

test("suspended and revoked delegated managers fail revalidation", () => {
  assert.equal(hasCurrentManagementPermission({ managementAccount: { status: "suspended", permissions: ["schedule.manage"] } }, "schedule.manage"), false);
  assert.equal(hasCurrentManagementPermission({ managementAccount: { status: "active", permissions: [] } }, "schedule.manage"), false);
  assert.equal(hasCurrentManagementPermission({}, "schedule.manage"), false);
});

test("permission failures use a safe session-change message", () => {
  for (const error of [new Error("permission denied"), new Error("403 forbidden"), new Error("row-level security")])
    assert.equal(managementActionErrorMessage(error, "저장 실패"), MANAGEMENT_ACCESS_CHANGED_MESSAGE);
  assert.equal(managementActionErrorMessage(new Error("network timeout"), "저장 실패"), "network timeout");
});
