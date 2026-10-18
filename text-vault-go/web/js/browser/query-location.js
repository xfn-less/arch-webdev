// This adapter is the sole owner of browser URL query state. Application
// queries remain plain data and can work without location or history globals.
export function createQueryLocation({location, history, addEventListener, removeEventListener}) {
  const subscribers = new Set();
  const changed = () => {
    const value = read();
    for (const subscriber of subscribers) subscriber(value);
  };
  addEventListener("hashchange", changed);

  function read() {
    return new URLSearchParams(location.hash.slice(1)).get("q") ?? "";
  }

  function readOrder() {
    return new URLSearchParams(location.hash.slice(1)).get("order") === "updated" ? "updatedAt" : "createdAt";
  }

  function write(query) {
    history.replaceState(history.state, "", url(query));
  }

  function url(query) {
    const next = new URL(location.href);
    const parameters = new URLSearchParams(next.hash.slice(1));
    if (query) parameters.set("q", String(query));
    else parameters.delete("q");
    next.hash = parameters.toString();
    return next.href;
  }

  function writeOrder(orderBy) {
    const next = new URL(location.href);
    const parameters = new URLSearchParams(next.hash.slice(1));
    if (orderBy === "updatedAt") parameters.set("order", "updated");
    else parameters.delete("order");
    next.hash = parameters.toString();
    history.replaceState(history.state, "", next.href);
  }

  function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  function destroy() {
    removeEventListener("hashchange", changed);
    subscribers.clear();
  }

  return {read, write, url, readOrder, writeOrder, subscribe, destroy};
}
