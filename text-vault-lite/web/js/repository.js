import {asEntry} from "./model.js";

export function createRepository(initial = []) {
  const objects = new Map();
  const subscribers = new Set();

  for (const value of initial) {
    const entry = asEntry(value);
    if (!entry.deletedAt) objects.set(entry.id, entry);
  }

  function get(id) {
    return objects.get(id);
  }

  function upsert(value) {
    const entry = asEntry(value);
    if (entry.deletedAt) {
      objects.delete(entry.id);
    } else {
      objects.set(entry.id, {...entry});
    }
    notify();
    return entry;
  }

  function remove(id) {
    if (!objects.has(id)) return false;
    objects.delete(id);
    notify();
    return true;
  }

  function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  function notify() {
    for (const callback of subscribers) callback();
  }

  return {
    get,
    upsert,
    remove,
    subscribe,
    values: () => [...objects.values()],
  };
}
