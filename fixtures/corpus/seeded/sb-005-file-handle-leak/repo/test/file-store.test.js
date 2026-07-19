import assert from "node:assert/strict";
import test from "node:test";
import { writeRecord } from "../src/file-store.js";

test("writes and closes a record", async () => {
  const calls = [];
  const handle = {
    writeFile: async (value) => calls.push(["write", value]),
    close: async () => calls.push(["close"])
  };

  await writeRecord(async () => handle, "record.txt", "ok");
  assert.deepEqual(calls, [["write", "ok"], ["close"]]);
});
