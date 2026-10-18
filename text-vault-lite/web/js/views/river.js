import van from "../../vendor/van-1.6.1.js";
import {deleteEntry, saveEntry} from "../api.js";
import {runQuery} from "../core/query.js";
import {createEntry} from "../model.js";

const {button, div, input, span, textarea} = van.tags;

export function createRiverView({root, repository, queryLocation}) {
  let query = queryLocation.read();
  let editing = null;

  const status = div({class: "sync-status"});
  const river = div({class: "river"});
  const search = input({
    type: "text",
    class: "search-input",
    spellcheck: false,
    autocomplete: "off",
    placeholder: "搜索",
    value: query,
  });
  const add = button({type: "button", class: "add-entry", onclick: startAdd}, "+");
  const shell = div(
    {class: "river-shell"},
    status,
    river,
    div({class: "search-control"}, search, add),
  );

  repository.subscribe(render);
  queryLocation.subscribe(value => {
    if (editing) return;
    query = value;
    search.value = value;
    render();
  });
  search.addEventListener("input", () => {
    if (editing) return;
    query = search.value;
    queryLocation.write(query);
    render();
  });
  document.addEventListener("click", onDocumentClick, true);

  root.replaceChildren(shell);
  render();

  function render() {
    const entries = runQuery(query, repository.values());
    add.disabled = Boolean(editing);
    river.replaceChildren(...entries.map(renderEntry));
    if (editing?.isNew) river.append(editorRow());
    if (editing) queueMicrotask(() => {
      const editor = river.querySelector(".entry-editor");
      if (!editor) return;
      grow(editor);
      editor.focus({preventScroll: true});
    });
  }

  function renderEntry(entry) {
    if (editing?.id === entry.id) return editorRow();
    return row(div({
      class: "entry-text",
      onclick: () => startEdit(entry),
    }, entry.text || " "));
  }

  function editorRow() {
    const editor = textarea({
      class: "entry-editor",
      spellcheck: false,
      rows: 1,
      value: editing.draft,
      oninput: event => {
        editing.draft = event.target.value;
        grow(event.target);
      },
      onkeydown: event => {
        if (event.isComposing) return;
        if (event.key === "Escape" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s")) {
          event.preventDefault();
          void commitEdit();
        }
      },
    });
    return row(div(editor));
  }

  function row(body) {
    return div({class: "river-entry"}, span({class: "entry-marker"}), body);
  }

  function startEdit(entry) {
    if (editing) return;
    editing = {id: entry.id, draft: entry.text, original: entry.text, isNew: false, createdAt: entry.createdAt};
    search.disabled = true;
    setStatus("");
    render();
  }

  function startAdd() {
    if (editing) return;
    editing = {id: "", draft: "", original: "", isNew: true};
    search.disabled = true;
    setStatus("");
    render();
  }

  async function commitEdit() {
    if (!editing) return;
    const draft = editing;
    const text = draft.draft.trim();
    editing = null;
    search.disabled = false;

    try {
      if (draft.isNew && text) {
        const entry = {...createEntry(), text};
        repository.upsert(entry);
        await saveEntry(entry);
      } else if (!draft.isNew && !text) {
        repository.remove(draft.id);
        await deleteEntry(draft.id);
      } else if (!draft.isNew && text !== draft.original) {
        const entry = {
          id: draft.id,
          text,
          createdAt: draft.createdAt,
          updatedAt: new Date().toISOString(),
        };
        repository.upsert(entry);
        await saveEntry(entry);
      }
      setStatus("");
    } catch (error) {
      setStatus(error.message || "失败");
    }

    query = queryLocation.read();
    search.value = query;
    render();
  }

  function onDocumentClick(event) {
    const editor = river.querySelector(".entry-editor");
    if (!editing || !editor || editor.contains(event.target)) return;
    void commitEdit();
  }

  function setStatus(text) {
    status.textContent = text;
    status.dataset.state = text ? "failed" : "clean";
  }
}

function grow(element) {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}
