import {encryptObject} from "./crypto.js";

export function createSaveCoordinator({
  repository,
  api,
  key,
  generation = 0,
  delayMs = 1000,
  beforeSave = null,
  onGeneration = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let currentGeneration = generation;
  let currentStatus = repository.isContentDirty() ? "dirty" : "clean";
  let activeSave = null;
  let timer = null;
  let saveRequested = false;
  const subscribers = new Set();

  repository.subscribe(() => {
    if (!activeSave && currentStatus !== "conflict" && currentStatus !== "failed") {
      setStatus(repository.isContentDirty() ? "dirty" : "clean");
    }
  });

  function save() {
    if (activeSave) {
      saveRequested = true;
      return activeSave;
    }
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    activeSave = prepareAndSave().finally(() => {
      activeSave = null;
      if (saveRequested) {
        saveRequested = false;
        schedule();
      }
    });
    return activeSave;
  }

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      return save().catch(() => {});
    }, delayMs);
  }

  async function prepareAndSave() {
    if (beforeSave) await beforeSave();
    // Capture happens after pulling so the upload uses the current server base.
    const captured = repository.captureDirty();
    if (captured.length === 0) {
      setStatus("clean");
      return {generation: currentGeneration};
    }
    setStatus("saving");
    return perform(captured);
  }

  async function perform(captured) {
    try {
      const objects = await Promise.all(captured.map(async item => {
        const revision = item.baseRevision + 1;
        const value = {...item.object, revision};
        const metadata = {id: value.id, kind: value.kind, revision};
        return {...metadata, envelope: await encryptObject(key, metadata, value)};
      }));
      const response = await api.commit({baseGeneration: currentGeneration, objects});
      currentGeneration = response.manifest.generation;
      onGeneration(currentGeneration);
      const revisions = Object.fromEntries(Object.entries(response.manifest.objects).map(([id, ref]) => [id, ref.revision]));
      repository.markCommitted(captured, revisions);
      setStatus(repository.isContentDirty() ? "dirty" : "clean");
      return response.manifest;
    } catch (error) {
      setStatus(error?.name === "ConflictError" ? "conflict" : "failed");
      throw error;
    }
  }

  function setStatus(value) {
    currentStatus = value;
    for (const subscriber of subscribers) subscriber(value);
  }

  function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  function setGeneration(value) {
    if (Number.isSafeInteger(value) && value >= currentGeneration) currentGeneration = value;
  }

  return {save, schedule, status: () => currentStatus, generation: () => currentGeneration, setGeneration, subscribe};
}
