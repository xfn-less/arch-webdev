import test from "node:test";
import assert from "node:assert/strict";
import {createRepository} from "../../web/js/repository.js";

const initial = {
  schemaVersion: 1,
  id: "268t00000",
  kind: "entry",
  text: "客户A old",
  properties: {},
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
  revision: 1,
};

test("unsaved edits immediately become dirty repository objects", () => {
  const repository = createRepository([initial]);

  repository.updateEntryText("268t00000", "客户A 1.2.3.4", "2026-08-29T01:00:00.000Z");

  assert.equal(repository.get("268t00000").text, "客户A 1.2.3.4");
  assert.equal(repository.isDirty(), true);
  assert.equal(repository.dirtyObjects().length, 1);
});

test("typing during save remains dirty after older snapshot commits", () => {
  const repository = createRepository([initial]);
  repository.updateEntryText("268t00000", "first", "2026-08-29T01:00:00.000Z");
  const snapshot = repository.captureDirty();
  repository.updateEntryText("268t00000", "second", "2026-08-29T02:00:00.000Z");

  repository.markCommitted(snapshot, {"268t00000": 2});

  assert.equal(repository.get("268t00000").text, "second");
  assert.equal(repository.isDirty(), true);
});

test("quiet workspace changes are pending without alarming the user", () => {
  const workspace = {schemaVersion: 1, id: "workspace_main_01", kind: "workspace", revision: 1, state: {schemaVersion: 1, tabs: []}};
  const repository = createRepository([workspace]);

  repository.upsert({...workspace, state: {...workspace.state, splitRatio: 0.42}}, {quiet: true});

  assert.equal(repository.hasPendingChanges(), true);
  assert.equal(repository.isContentDirty(), false);
  assert.equal(repository.captureDirty().length, 1);
});

test("a newer remote object replaces a clean local object", () => {
  const repository = createRepository([initial]);
  const remote = {...initial, text: "remote", revision: 2, updatedAt: "2026-08-29T01:00:00.000Z"};

  assert.deepEqual(repository.applyRemote([remote]), {applied: ["268t00000"], conflicts: [], renamed: []});
  assert.equal(repository.get("268t00000").text, "remote");
  assert.equal(repository.isDirty(), false);
});

test("remote changes to other objects preserve local dirty edits", () => {
  const repository = createRepository([initial]);
  repository.updateEntryText("268t00000", "local");
  const remote = {...initial, id: "268t00001", text: "other", revision: 1};

  repository.applyRemote([remote]);

  assert.equal(repository.get("268t00000").text, "local");
  assert.equal(repository.get("268t00001").text, "other");
  assert.equal(repository.isDirty(), true);
});

test("same-object concurrent edits preserve remote text as a conflict copy", () => {
  const repository = createRepository([initial]);
  repository.updateEntryText("268t00000", "local", "2026-08-29T02:00:00.000Z");
  const remote = {...initial, text: "remote", revision: 2, updatedAt: "2026-08-29T01:00:00.000Z"};

  const result = repository.applyRemote([remote], new Date(2026, 7, 29, 3, 0));

  assert.equal(result.applied.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(repository.get("268t00000").text, "local");
  const copy = repository.get(result.conflicts[0]);
  assert.equal(copy.text, "remote");
  assert.deepEqual(copy.properties.conflict, {of: "268t00000", remoteRevision: 2});
  assert.equal(repository.captureDirty().length, 2);

  assert.deepEqual(repository.applyRemote([remote]), {applied: [], conflicts: [], renamed: []});
});

test("a remote object colliding with an unsaved memo renames the local memo", () => {
  const local = {...initial, text: "local new", revision: 0, createdAt: "2026-08-29T00:00:00.000Z"};
  const repository = createRepository([]);
  repository.upsert(local);
  const remote = {...initial, text: "remote winner", revision: 1};
  const events = [];
  repository.subscribe(event => events.push(event));

  const result = repository.applyRemote([remote]);

  assert.deepEqual(result, {applied: ["268t00000"], conflicts: [], renamed: [{from: "268t00000", to: "268t00001"}]});
  assert.equal(repository.get("268t00000").text, "remote winner");
  assert.equal(repository.get("268t00001").text, "local new");
  assert.equal(repository.captureDirty().length, 1);
  assert.equal(repository.captureDirty()[0].baseRevision, 0);
  assert.deepEqual(events.at(-1), {type: "rename", from: "268t00000", to: "268t00001"});
});

test("conflicts remain visible until their copy is opened and acknowledged", () => {
  const repository = createRepository([initial]);
  repository.updateEntryText("268t00000", "local");
  const remote = {...initial, text: "remote", revision: 2};
  const {conflicts} = repository.applyRemote([remote], new Date(2026, 7, 29, 3, 0));

  assert.equal(repository.hasConflicts(), true);
  assert.equal(repository.acknowledgeConflict(conflicts[0]), true);
  assert.equal(repository.hasConflicts(), false);
  assert.equal(repository.get(conflicts[0]).text, "remote");
});

test("quarantined ciphertext keeps a persistent repository error", () => {
  const repository = createRepository([]);
  repository.quarantine("268t00009", new Error("bad ciphertext"));
  assert.equal(repository.hasQuarantined(), true);
  assert.deepEqual(repository.quarantinedIDs(), ["268t00009"]);
  assert.deepEqual(repository.knownIDs(), ["268t00009"]);
});

test("a later healthy revision clears quarantine", () => {
  const repository = createRepository([]);
  repository.quarantine("268t00009", new Error("bad ciphertext"));
  const recovered = {...initial, id: "268t00009", revision: 2, text: "recovered"};

  repository.applyRemote([recovered]);

  assert.equal(repository.hasQuarantined(), false);
  assert.equal(repository.get("268t00009").text, "recovered");
});
