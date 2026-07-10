import assert from "node:assert/strict";
import { test } from "node:test";
import { handleGetAdminStatus } from "../src/admin-routes.js";

test("GET admin status requires admin session", () => {
  assert.throws(() => handleGetAdminStatus({ session: { isAdmin: false } }), /forbidden/);
});

test("GET admin status succeeds for admin session", () => {
  assert.deepEqual(handleGetAdminStatus({ session: { isAdmin: true } }), { status: "ok" });
});
