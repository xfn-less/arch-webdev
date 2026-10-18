import {createEntry, newMemoID, nextMemoID, validateObject} from "./model.js";

export function createRepository(initialObjects = []) {
  const objects = new Map();
  const sequences = new Map();
  const committedSequences = new Map();
  const baseRevisions = new Map();
  const contentDirty = new Map();
  const quarantined = new Map();
  const subscribers = new Set();

  for (const value of initialObjects) {
    const object = structuredClone(validateObject(value));
    objects.set(object.id, object);
    sequences.set(object.id, 0);
    committedSequences.set(object.id, 0);
    baseRevisions.set(object.id, object.revision);
    contentDirty.set(object.id, false);
  }

  function get(id) {
    return objects.get(id);
  }

  // Quiet objects (workspace/layout) join the next persistence batch without
  // presenting themselves as unsaved user content.
  function upsert(value, {quiet = false} = {}) {
    const object = structuredClone(validateObject(value));
    const nextSequence = (sequences.get(object.id) ?? 0) + 1;
    objects.set(object.id, object);
    sequences.set(object.id, nextSequence);
    if (!committedSequences.has(object.id)) committedSequences.set(object.id, -1);
    if (!baseRevisions.has(object.id)) baseRevisions.set(object.id, object.revision);
    if (!quiet) contentDirty.set(object.id, true);
    notify({type: "upsert", id: object.id});
    return object;
  }

  function updateEntryText(id, text, now = new Date().toISOString()) {
    const current = objects.get(id);
    if (!current || current.kind !== "entry") throw new TypeError("entry not found");
    if (current.text === text) return current;
    return upsert({...current, text, updatedAt: now});
  }

  function remove(id) {
    if (!objects.has(id)) return false;
    objects.delete(id);
    sequences.set(id, (sequences.get(id) ?? 0) + 1);
    notify({type: "remove", id});
    return true;
  }

  function isDirty() {
    return isContentDirty();
  }

  function isContentDirty() {
    return [...contentDirty.values()].some(Boolean);
  }

  function hasPendingChanges() {
    return [...sequences].some(([id, sequence]) => sequence !== committedSequences.get(id));
  }

  function dirtyObjects() {
    return captureDirty().map(item => item.object);
  }

  function captureDirty() {
    const result = [];
    for (const [id, sequence] of sequences) {
      if (sequence === committedSequences.get(id)) continue;
      const object = objects.get(id);
      if (object) result.push({id, sequence, baseRevision: baseRevisions.get(id) ?? 0, object: structuredClone(object)});
    }
    return result;
  }

  function markCommitted(snapshot, returnedRevisions) {
    for (const captured of snapshot) {
      const revision = returnedRevisions[captured.id];
      if (!Number.isSafeInteger(revision)) continue;
      baseRevisions.set(captured.id, revision);
      const current = objects.get(captured.id);
      if (current) objects.set(captured.id, {...current, revision});
      if (sequences.get(captured.id) === captured.sequence) {
        committedSequences.set(captured.id, captured.sequence);
        contentDirty.set(captured.id, false);
      }
    }
    notify({type: "commit"});
  }

  // Pulls never overwrite unsaved text. If both sides changed the same entry,
  // the original keeps the local edit and a normal dirty entry preserves the
  // remote text. Advancing baseRevision lets the next save follow the server.
  function applyRemote(remoteObjects, now = new Date()) {
    const applied = [];
    const conflicts = [];
    const renamed = [];
    for (const value of remoteObjects) {
      const remote = structuredClone(validateObject(value));
      const current = objects.get(remote.id);
      const baseRevision = baseRevisions.get(remote.id) ?? 0;
      if (quarantined.delete(remote.id)) notify({type: "recovered", id: remote.id});
      if (remote.revision <= baseRevision) continue;

      if (current && sequences.get(remote.id) !== committedSequences.get(remote.id)) {
        // Two tabs may allocate the same memo sequence from the same snapshot.
        // An object that has never reached revision 1 is an ID collision, not
        // a content edit conflict: move the local draft and adopt the winner.
        if (baseRevision === 0 && current.revision === 0) {
          const id = nextMemoID(knownIDs(), current.id);
          const local = {...current, id};
          discardTracking(remote.id);
          installRemote(remote);
          upsert(local);
          notify({type: "rename", from: remote.id, to: id});
          applied.push(remote.id);
          renamed.push({from: remote.id, to: id});
          continue;
        }
        const id = newMemoID(knownIDs(), now);
        const conflict = {
          ...createEntry({id, now: now.toISOString()}),
          text: remote.text,
          properties: {...remote.properties, conflict: {of: remote.id, remoteRevision: remote.revision}},
        };
        upsert(conflict);
        baseRevisions.set(remote.id, remote.revision);
        conflicts.push(id);
        continue;
      }

      installRemote(remote);
      applied.push(remote.id);
      notify({type: "remote", id: remote.id});
    }
    return {applied, conflicts, renamed};
  }

  function installRemote(remote) {
    objects.set(remote.id, remote);
    sequences.set(remote.id, 0);
    committedSequences.set(remote.id, 0);
    baseRevisions.set(remote.id, remote.revision);
    contentDirty.set(remote.id, false);
  }

  function discardTracking(id) {
    objects.delete(id);
    sequences.delete(id);
    committedSequences.delete(id);
    baseRevisions.delete(id);
    contentDirty.delete(id);
  }

  function hasConflicts() {
    return [...objects.values()].some(object => object.kind === "entry" && object.properties?.conflict);
  }

  // Opening a conflict copy is the explicit acknowledgement. Its text stays
  // as a normal entry; only the system marker is removed and saved.
  function acknowledgeConflict(id) {
    const object = objects.get(id);
    if (!object?.properties?.conflict) return false;
    const properties = {...object.properties};
    delete properties.conflict;
    upsert({...object, properties});
    return true;
  }

  function quarantine(id, error) {
    quarantined.set(id, error instanceof Error ? error.message : String(error));
    notify({type: "quarantine", id});
  }

  function knownIDs() {
    return [...new Set([...objects.keys(), ...quarantined.keys()])];
  }

  function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  function notify(event) {
    for (const subscriber of subscribers) subscriber(event);
  }

  return {
    get, upsert, remove, isDirty, isContentDirty, hasPendingChanges,
    dirtyObjects, captureDirty, markCommitted, applyRemote, updateEntryText,
    hasConflicts, acknowledgeConflict, quarantine,
    hasQuarantined: () => quarantined.size > 0,
    quarantinedIDs: () => [...quarantined.keys()],
    knownIDs,
    subscribe, values: () => [...objects.values()],
  };
}
