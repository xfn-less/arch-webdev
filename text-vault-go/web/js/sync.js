import {decryptObject} from "./crypto.js";
import {validateObject} from "./model.js";

export function createSyncCoordinator({
  repository,
  api,
  key,
  generation = 0,
  intervalMs = 2000,
  decrypt = decryptObject,
  onGeneration = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let currentGeneration = generation;
  let currentStatus = "idle";
  let activePull = null;
  let timer = null;
  let running = false;
  const subscribers = new Set();

  // A pull is shared by every caller so focus, open, polling, and autosave can
  // safely request freshness without producing overlapping HTTP requests.
  function pull() {
    if (activePull) return activePull;
    activePull = performPull().finally(() => { activePull = null; });
    return activePull;
  }

  async function performPull() {
    // Keep a failed connection visibly failed while a background retry runs.
    // A successful pull below is the only event that clears the red status.
    if (currentStatus !== "failed") setStatus("syncing");
    try {
      const response = await api.changes(currentGeneration);
      const encryptedObjects = Object.values(response.objects ?? {});
      const settled = await Promise.allSettled(encryptedObjects.map(async encrypted => {
        const metadata = {id: encrypted.id, kind: encrypted.kind, revision: encrypted.revision};
        return validateObject(await decrypt(key, metadata, encrypted.envelope));
      }));
      const decrypted = [];
      const failed = [];
      settled.forEach((item, index) => {
        if (item.status === "fulfilled") decrypted.push(item.value);
        else {
          const id = encryptedObjects[index].id;
          failed.push(id);
          repository.quarantine(id, item.reason);
        }
      });
      const result = repository.applyRemote(decrypted);
      if (failed.length) result.failed = failed;
      setGeneration(response.generation);
      setStatus(repository.hasQuarantined() ? "failed" : repository.hasConflicts() ? "conflict" : "idle");
      return result;
    } catch (error) {
      setStatus("failed");
      throw error;
    }
  }

  function start() {
    if (running) return;
    running = true;
    scheduleNext();
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimer(async () => {
      timer = null;
      try { await pull(); } catch {}
      scheduleNext();
    }, intervalMs);
  }

  function stop() {
    running = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function setGeneration(value) {
    if (!Number.isSafeInteger(value) || value < currentGeneration) return;
    currentGeneration = value;
    onGeneration(value);
  }

  function setStatus(value) {
    currentStatus = value;
    for (const subscriber of subscribers) subscriber(value);
  }

  function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  return {pull, start, stop, generation: () => currentGeneration, setGeneration, status: () => currentStatus, subscribe};
}
