import {loadEntries} from "./api.js";
import {createQueryLocation} from "./browser/query-location.js";
import {createRepository} from "./repository.js";
import {createRiverView} from "./views/river.js";

const root = document.querySelector("#app");

// Load from SQLite → repository → query URL → river view.
async function main() {
  let entries;
  try {
    entries = await loadEntries();
  } catch {
    root.textContent = "无法连接服务器";
    return;
  }

  const repository = createRepository(entries);
  const queryLocation = createQueryLocation({
    location: window.location,
    history: window.history,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
  });
  createRiverView({root, repository, queryLocation});
}

main();
