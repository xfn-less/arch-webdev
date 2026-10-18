import test from "node:test";
import assert from "node:assert/strict";
import {createRepository} from "../../web/js/repository.js";
import {createSyncCoordinator} from "../../web/js/sync.js";

const entry = {
  schemaVersion: 1, id: "268t00000", kind: "entry", text: "remote", properties: {},
  createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T01:00:00.000Z", revision: 2,
};

test("pull decrypts changes, merges them, and advances generation", async () => {
  const repository = createRepository([]);
  const generations = [];
  const sync = createSyncCoordinator({
    repository,
    api: {changes: async after => {
      assert.equal(after, 1);
      return {generation: 3, objects: {"268t00000": {id: "268t00000", kind: "entry", revision: 2, envelope: {ciphertext: "x"}}}};
    }},
    key: {},
    generation: 1,
    decrypt: async () => entry,
    onGeneration: value => generations.push(value),
  });

  assert.deepEqual(await sync.pull(), {applied: ["268t00000"], conflicts: [], renamed: []});
  assert.equal(repository.get("268t00000").text, "remote");
  assert.equal(sync.generation(), 3);
  assert.deepEqual(generations, [3]);
});

test("overlapping pulls share one request and failures remain retryable", async () => {
  const repository = createRepository([]);
  const pending = Promise.withResolvers();
  let calls = 0;
  const statuses = [];
  const sync = createSyncCoordinator({
    repository, key: {}, generation: 0, decrypt: async () => entry,
    api: {changes: () => { calls += 1; return pending.promise; }},
  });
  sync.subscribe(status => statuses.push(status));

  const first = sync.pull();
  const second = sync.pull();
  assert.equal(first, second);
  pending.reject(new Error("offline"));
  await assert.rejects(first, /offline/);
  await assert.rejects(() => sync.pull(), /offline/);
  assert.equal(calls, 2);
  assert.deepEqual(statuses, ["syncing", "failed", "failed"]);
});

test("start polls and stop cancels the timer", () => {
  const scheduled = [];
  const cleared = [];
  const sync = createSyncCoordinator({
    repository: createRepository([]), key: {}, api: {changes: async () => ({generation: 0, objects: {}})},
    setTimer: (callback, delay) => { scheduled.push({callback, delay}); return 17; },
    clearTimer: id => cleared.push(id),
  });

  sync.start();
  assert.equal(scheduled[0].delay, 2000);
  sync.stop();
  assert.deepEqual(cleared, [17]);
});

test("one bad ciphertext is quarantined while valid changes still merge", async () => {
  const repository = createRepository([]);
  const encrypted = id => ({id, kind: "entry", revision: 1, envelope: {ciphertext: id}});
  const sync = createSyncCoordinator({
    repository, key: {}, generation: 0,
    api: {changes: async () => ({generation: 1, objects: {good: encrypted("268t00000"), bad: encrypted("268t00001")}})},
    decrypt: async (_key, metadata) => {
      if (metadata.id === "268t00001") throw new Error("corrupt");
      return {...entry, id: metadata.id, revision: metadata.revision};
    },
  });

  const result = await sync.pull();
  assert.equal(repository.get("268t00000").text, "remote");
  assert.deepEqual(result.failed, ["268t00001"]);
  assert.equal(sync.generation(), 1);
  assert.equal(sync.status(), "failed");
});
