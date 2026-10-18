export function createQueryLocation({location, history, addEventListener, removeEventListener}) {
  const subscribers = new Set();
  const onHash = () => {
    const value = read();
    for (const subscriber of subscribers) subscriber(value);
  };
  addEventListener("hashchange", onHash);

  function read() {
    return new URLSearchParams(location.hash.slice(1)).get("q") ?? "";
  }

  function write(query) {
    const next = new URL(location.href);
    const params = new URLSearchParams(next.hash.slice(1));
    if (query) params.set("q", String(query));
    else params.delete("q");
    next.hash = params.toString();
    history.replaceState(history.state, "", next.href);
  }

  function subscribe(callback) {
    subscribers.add(callback);
    return () => subscribers.delete(callback);
  }

  function destroy() {
    removeEventListener("hashchange", onHash);
    subscribers.clear();
  }

  return {read, write, subscribe, destroy};
}
