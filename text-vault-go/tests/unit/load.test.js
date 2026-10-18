import test from "node:test";
import assert from "node:assert/strict";
import {decryptSnapshot} from "../../web/js/load.js";

test("snapshot loading isolates one bad object", async () => {
  const snapshot = {objects: {
    good: {id: "268t00000", kind: "entry", revision: 1, envelope: {}},
    bad: {id: "268t00001", kind: "entry", revision: 1, envelope: {}},
  }};
  const object = id => ({schemaVersion: 1, id, kind: "entry", text: id, properties: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", revision: 1});

  const loaded = await decryptSnapshot({}, snapshot, {decrypt: async (_key, metadata) => {
    if (metadata.id === "268t00001") throw new Error("corrupt");
    return object(metadata.id);
  }});

  assert.deepEqual(loaded.objects.map(item => item.id), ["268t00000"]);
  assert.deepEqual(loaded.failures.map(item => item.id), ["268t00001"]);
});
