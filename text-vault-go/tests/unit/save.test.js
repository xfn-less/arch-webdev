import test from "node:test";
import assert from "node:assert/strict";
import {createRepository} from "../../web/js/repository.js";
import {createSaveCoordinator} from "../../web/js/save.js";

function seededRepository() {
  return createRepository([{
    schemaVersion: 1, id: "268t00000", kind: "entry", text: "base", properties: {},
    createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", revision: 1,
  }]);
}

test("one save commits every dirty object and preserves edits made in flight", async () => {
  const pending = Promise.withResolvers();
  let submitted;
  const api = {commit: request => { submitted = request; return pending.promise; }};
  const key = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  const repository = seededRepository();
  repository.updateEntryText("268t00000", "first edit", "2026-08-29T01:00:00.000Z");
  const saver = createSaveCoordinator({repository, api, key, generation: 3});

  const saving = saver.save();
  repository.updateEntryText("268t00000", "second edit", "2026-08-29T02:00:00.000Z");
  pending.resolve({manifest: {generation: 4, objects: {"268t00000": {kind: "entry", revision: 2}}}});
  await saving;

  assert.equal(submitted.baseGeneration, 3);
  assert.equal(submitted.objects.length, 1);
  assert.equal(saver.status(), "dirty");
  assert.equal(repository.get("268t00000").text, "second edit");
});

test("conflict preserves memory and exposes one global state", async () => {
  const repository = seededRepository();
  repository.updateEntryText("268t00000", "local", "2026-08-29T01:00:00.000Z");
  const key = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  const error = new Error("conflict");
  error.name = "ConflictError";
  const saver = createSaveCoordinator({repository, key, generation: 1, api: {commit: async () => { throw error; }}});

  await assert.rejects(() => saver.save(), /conflict/);

  assert.equal(saver.status(), "conflict");
  assert.equal(repository.get("268t00000").text, "local");
});

test("quiet workspace changes save without changing the clean status", async () => {
  const repository = seededRepository();
  repository.upsert({schemaVersion: 1, id: "workspace_main_01", kind: "workspace", revision: 0, state: {schemaVersion: 1, tabs: []}}, {quiet: true});
  const key = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  let submitted;
  const saver = createSaveCoordinator({repository, key, generation: 1, api: {commit: async request => {
    submitted = request;
    return {manifest: {generation: 2, objects: {workspace_main_01: {kind: "workspace", revision: 1}, "268t00000": {kind: "entry", revision: 1}}}};
  }}});

  assert.equal(saver.status(), "clean");
  await saver.save();
  assert.equal(submitted.objects.length, 1);
  assert.equal(saver.status(), "clean");
});

test("schedule debounces edits and uses the same save path", async () => {
  const repository = seededRepository();
  repository.updateEntryText("268t00000", "scheduled");
  const key = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  const timers = [];
  let commits = 0;
  const saver = createSaveCoordinator({
    repository, key, generation: 1, delayMs: 1000,
    setTimer: callback => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
    api: {commit: async () => {
      commits += 1;
      return {manifest: {generation: 2, objects: {"268t00000": {kind: "entry", revision: 2}}}};
    }},
  });

  saver.schedule();
  saver.schedule();
  assert.equal(commits, 0);
  await timers.at(-1)();
  assert.equal(commits, 1);
  assert.equal(saver.status(), "clean");
});

test("save pulls before capturing and publishes its generation", async () => {
  const repository = seededRepository();
  repository.updateEntryText("268t00000", "local");
  const key = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  const events = [];
  const saver = createSaveCoordinator({
    repository, key, generation: 1,
    beforeSave: async () => { events.push("pull"); },
    onGeneration: generation => events.push(`generation:${generation}`),
    api: {commit: async request => {
      events.push(`commit:${request.baseGeneration}`);
      return {manifest: {generation: 2, objects: {"268t00000": {kind: "entry", revision: 2}}}};
    }},
  });

  await saver.save();
  assert.deepEqual(events, ["pull", "commit:1", "generation:2"]);
});

test("debounce firing during a slow save schedules the newer edit", async () => {
  const repository = seededRepository();
  const key = await crypto.subtle.generateKey({name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  const firstCommit = Promise.withResolvers();
  const timers = [];
  let commits = 0;
  const saver = createSaveCoordinator({
    repository, key, generation: 1,
    setTimer: callback => { timers.push(callback); return timers.length; }, clearTimer: () => {},
    api: {commit: request => {
      commits += 1;
      if (commits === 1) return firstCommit.promise;
      return Promise.resolve({manifest: {generation: 3, objects: {"268t00000": {kind: "entry", revision: 3}}}});
    }},
  });

  repository.updateEntryText("268t00000", "first");
  const firstSave = saver.save();
  repository.updateEntryText("268t00000", "second");
  saver.schedule();
  const joinedSave = timers[0]();
  firstCommit.resolve({manifest: {generation: 2, objects: {"268t00000": {kind: "entry", revision: 2}}}});
  await Promise.all([firstSave, joinedSave]);

  assert.equal(timers.length, 2);
  await timers[1]();
  assert.equal(commits, 2);
  assert.equal(saver.status(), "clean");
});
