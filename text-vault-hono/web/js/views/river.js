import van from "../../vendor/van-1.6.1.js";
import {runQuery} from "../core/query.js";
import {parseReplacement, previewReplacement, applyReplacement} from "../core/batch-replace.js";
import {textLinks} from "../core/text-links.js";
import {createEntry} from "../model.js";
import {parseTotpEntry, generateTotp} from "../core/totp.js";

const {a, button, div, input, span, textarea} = van.tags;

// One flat list, one optional draft, and one URL-backed search. No view framework.
export function createRiverView({root, repository, saver, sync, queryLocation, now = () => new Date()}) {
  let query = queryLocation.read();
  let editing = null;
  let selectedId = null;
  let visibleEntries = [];
  let destroyed = false;
  let replacing = false;
  let replacement = null;
  let preview = [];
  const status = div({class: "sync-status", "data-state": "clean", role: "status", "aria-label": "已保存"});
  const river = div({class: "river", role: "list", "aria-label": "条目列表"});
  const search = input({type: "text", class: "search-input", spellcheck: false, autocomplete: "off", "aria-label": "搜索", placeholder: '搜索', value: query});
  const add = button({type: "button", class: "add-entry", "aria-label": "新增条目", onclick: startAdd}, "+");
  const searchError = div({class: "search-error", role: "alert", hidden: true});
  const searchControl = div({class: "search-control"}, search, add, searchError);
  const shell = div({class: "river-shell"}, status, river, searchControl);
  const cleanups = [repository.subscribe(renderEntries), saver.subscribe(renderStatus), sync.subscribe(renderStatus), queryLocation.subscribe(onLocationChange)];
  search.addEventListener("input", onSearch);
  search.addEventListener("keydown", onSearchKeydown);
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onDocumentKeydown);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("beforeunload", onBeforeUnload);
  root.replaceChildren(shell);
  renderEntries();
  renderStatus();

  function renderEntries() {
    if (destroyed || replacing) return;
    const oldEditor = river.querySelector(".entry-editor");
    const caret = oldEditor && {start: oldEditor.selectionStart, end: oldEditor.selectionEnd};
    const scrollTop = river.scrollTop;
    try {
      replacement = parseReplacement(query);
      preview = replacement ? previewReplacement(repository.values(), replacement) : [];
      visibleEntries = replacement ? [] : runQuery({type: "full-text", text: query, orderBy: "createdAt", direction: "asc"}, repository.values());
      searchError.hidden = true;
      searchError.textContent = "";
      search.removeAttribute("aria-invalid");
    } catch (error) {
      replacement = null; preview = [];
      visibleEntries = [];
      searchError.textContent = error.message;
      searchError.hidden = false;
      search.setAttribute("aria-invalid", "true");
    }
    add.disabled = Boolean(editing || replacing || replacement);
    // Remote changes must never remove a draft from the visible list.
    if (editing && !editing.isNew && !visibleEntries.some(entry => entry.id === editing.id)) {
      const entry = repository.get(editing.id);
      if (entry) visibleEntries.push(entry);
    }
    if (!visibleEntries.some(entry => entry.id === selectedId)) selectedId = null;
    river.replaceChildren(...visibleEntries.map(renderEntry));
    if (replacement) {
      const deleted = preview.filter(item => !item.text.trim()).length;
      river.append(div({class: "replace-summary"},
        span(`预览：${preview.length} 条，全文替换${deleted ? `，其中 ${deleted} 条将删除` : ""}`),
        span({class: "replace-hint"}, preview.length ? "Enter 替换" : "没有需要替换的正文")));
      for (const item of preview) river.append(div({class: "replace-preview"},
        div({class: "replace-before"}, item.original), div({class: "replace-after"}, item.text.trim() ? item.text : "（删除条目）")));
    }
    if (editing?.isNew) river.append(renderEditorRow("new"));
    river.scrollTop = scrollTop;
    if (editing) queueMicrotask(() => {
      const editor = river.querySelector(".entry-editor");
      if (!editor || !editing) return;
      grow(editor);
      editor.focus({preventScroll: true});
      const start = caret?.start ?? editing.initialCaret ?? editor.value.length;
      editor.setSelectionRange(start, caret?.end ?? start);
    });
  }

  async function executeReplacement() {
    if (editing || replacing || !preview.length) return;
    const confirmed = preview;
    replacing = true; search.disabled = true; add.disabled = true;
    river.querySelector(".replace-hint").textContent = "保存中…";
    let failure = "";
    try {
      await saver.save();
      await sync.pull();
      applyReplacement(repository, confirmed);
      await saver.save();
    } catch (error) { failure = error.message || "保存失败，请重试"; }
    finally {
      replacing = false; search.disabled = false; add.disabled = false; renderEntries(); renderStatus();
      search.focus({preventScroll: true});
      if (failure) { searchError.textContent = failure; searchError.hidden = false; }
    }
  }

  function linkedText(text) {
    return textLinks(text).map(part => {
      if (part.type === "search") return a({class: "search-link", href: queryLocation.url(part.query)}, part.text);
      if (part.type === "url") return a({class: "external-link", href: part.href, target: "_blank", rel: "noopener noreferrer"}, part.text);
      return part.text;
    });
  }

  function renderEntry(entry) {
    if (editing?.id === entry.id) return renderEditorRow(entry.id);
    const body = div({class: "entry-text", onclick: event => {
      if (event.target.closest("a") || !window.getSelection()?.isCollapsed) return;
      startEdit(entry, textOffsetAtPoint(event.currentTarget, event.clientX, event.clientY));
    }}, ...linkedText(entry.text || " "));
    const copy = totpButton(entry.text);
    return row(entry.id, copy ? div({class: "entry-with-totp"}, copy, body) : body);
  }

  function renderEditorRow(id) {
    const editor = textarea({class: "entry-editor", "data-editor-id": id, "aria-label": "编辑条目", spellcheck: false, rows: 1, value: editing.draft,
      oninput: event => { editing.draft = event.target.value; grow(event.target); renderStatus(); },
      onkeydown: event => {
        if (event.isComposing) return;
        if (event.key !== "Escape" && !((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s")) return;
        event.preventDefault(); event.stopPropagation(); void commitEdit();
      },
    });
    return row(id, div(editor, div({class: "entry-edit-error", role: "alert"}, editing.error || "")));
  }

  function row(id, body) {
    return div({class: "river-entry", role: "listitem", tabindex: -1, "data-entry-id": id, "data-selected": String(id === selectedId)},
      span({class: "entry-marker", "aria-hidden": "true"}), body);
  }

  function startEdit(entry, initialCaret) {
    if (editing || replacing) return;
    selectedId = entry.id;
    const draft = entry.text;
    editing = {id: entry.id, draft, original: entry.text, originalRevision: entry.revision, isNew: false, initialCaret: initialCaret ?? draft.length};
    beginEditing();
  }

  function startAdd() {
    if (editing || replacing || replacement) return;
    editing = {id: "", draft: "", original: "", isNew: true};
    beginEditing();
    queueMicrotask(() => { river.scrollTop = river.scrollHeight; river.querySelector(".entry-editor")?.focus(); });
  }

  function beginEditing() {
    search.disabled = true;
    add.disabled = true;
    renderEntries(); renderStatus();
  }

  async function commitEdit() {
    if (!editing) return;
    const finished = editing;
    try {
      if (!finished.isNew) {
        const current = repository.get(finished.id);
        if (!current || current.deletedAt || current.text !== finished.original || current.revision !== finished.originalRevision) throw new Error("条目已在别处修改，当前输入已保留；请先复制，再刷新核对");
      }
    } catch (error) {
      finished.error = error.message;
      river.querySelector(".entry-edit-error").textContent = error.message;
      river.querySelector(".entry-editor")?.focus();
      return;
    }
    const text = finished.draft.trim();
    editing = null; search.disabled = false; add.disabled = false;
    let changed = false;
    if (finished.isNew && text) {
      const instant = now();
      const iso = instant instanceof Date ? instant.toISOString() : String(instant);
      const entry = {...createEntry({existingIDs: repository.knownIDs(), now: iso}), text};
      selectedId = entry.id; repository.upsert(entry); changed = true;
    } else if (!finished.isNew && !text) {
      changed = repository.remove(finished.id);
    } else if (!finished.isNew && text !== finished.original) {
      repository.upsert({...repository.get(finished.id), text, updatedAt: new Date().toISOString()}); changed = true;
    }
    // A hash navigation arriving during editing is applied only after the draft commits.
    query = queryLocation.read(); search.value = query;
    renderEntries(); renderStatus();
    if (changed) try { await saver.save(); } catch {}
  }

  function onDocumentClick(event) {
    const editor = river.querySelector(".entry-editor");
    if (!editing || !editor || editor.contains(event.target)) return;
    // First click saves; a second click may open a different entry or follow its link.
    if (event.target.closest?.(".river-entry, .search-control")) { event.preventDefault(); event.stopPropagation(); }
    void commitEdit();
  }

  function selectEntry(step) {
    if (!visibleEntries.length) return;
    const index = visibleEntries.findIndex(entry => entry.id === selectedId);
    const next = index < 0 ? (step > 0 ? 0 : visibleEntries.length - 1) : Math.max(0, Math.min(visibleEntries.length - 1, index + step));
    selectedId = visibleEntries[next].id;
    for (const row of river.querySelectorAll(".river-entry")) {
      row.dataset.selected = String(row.dataset.entryId === selectedId);
      if (row.dataset.selected === "true") { row.focus({preventScroll: true}); row.scrollIntoView({block: "nearest"}); }
    }
  }

  function onDocumentKeydown(event) {
    if (event.isComposing || event.altKey) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !editing) {
      event.preventDefault(); void saver.save().catch(() => {}); return;
    }
    if (event.ctrlKey || event.metaKey || editing || replacing || event.target.closest?.("textarea, input, button, a, select, [contenteditable=true]")) return;
    if (event.key === "j" || event.key === "k") { event.preventDefault(); selectEntry(event.key === "j" ? 1 : -1); }
    else if (event.key === "Enter") {
      const entry = visibleEntries.find(entry => entry.id === selectedId);
      if (entry) { event.preventDefault(); startEdit(entry); }
    } else if (event.key === "/") { event.preventDefault(); search.focus(); }
    else if (event.key === "o") { event.preventDefault(); startAdd(); }
    else if (event.key === "Escape") { event.preventDefault(); search.value = ""; onSearch(); }
  }

  function onSearchKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && replacement) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) void executeReplacement();
      return;
    }
    if (event.key === "Escape" || event.key === "Enter") { event.preventDefault(); event.stopPropagation(); search.blur(); }
  }

  function onSearch() {
    if (editing) return;
    query = search.value; selectedId = null;
    queryLocation.write(query); renderEntries();
    river.scrollTop = 0;
  }

  function onLocationChange(value) {
    if (editing) return;
    query = value; search.value = value; selectedId = null;
    renderEntries(); river.scrollTop = 0;
  }

  function renderStatus() {
    let state = "clean";
    if (repository.hasQuarantined() || repository.hasConflicts() || ["failed", "conflict"].includes(saver.status()) || ["failed", "conflict"].includes(sync.status())) state = "failed";
    else if (editing) state = "editing";
    else if (repository.hasPendingChanges() || ["dirty", "saving"].includes(saver.status())) state = "saving";
    status.dataset.state = state;
    status.setAttribute("aria-label", ({clean: "已保存", editing: "正在编辑", saving: "正在保存", failed: "同步失败"})[state]);
  }

  function totpButton(text) {
    const parsed = parseTotpEntry(text);
    if (!parsed) return null;
    if (parsed.error) return span({role: "status"}, parsed.error);
    return button({type: "button", class: "entry-totp-copy", "aria-label": "复制验证码", onclick: async event => {
      const target = event.currentTarget; target.disabled = true;
      try {
        const time = () => new Date(now()).getTime();
        const counter = () => Math.floor(time() / 1000 / parsed.config.period);
        let result = await generateTotp(parsed.config, time());
        if (result.counter !== counter()) result = await generateTotp(parsed.config, time());
        if (result.counter !== counter()) throw new Error("expired");
        if (!target.isConnected) return;
        await navigator.clipboard.writeText(result.code); target.textContent = "已复制";
      } catch { target.textContent = "复制失败，请重试"; }
      finally { target.disabled = false; }
    }}, "复制验证码");
  }

  function onWindowFocus() { void sync.pull().catch(() => {}); }
  function onBeforeUnload(event) {
    if (!editing && !repository.hasPendingChanges()) return;
    event.preventDefault(); event.returnValue = "";
  }
  return () => {
    destroyed = true;
    for (const cleanup of cleanups) cleanup();
    document.removeEventListener("click", onDocumentClick, true);
    document.removeEventListener("keydown", onDocumentKeydown);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}

function grow(element) {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function textOffsetAtPoint(element, x, y) {
  const position = document.caretPositionFromPoint?.(x, y);
  const legacy = !position && document.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? legacy?.startContainer;
  const offset = position?.offset ?? legacy?.startOffset;
  if (!node || offset === undefined || !element.contains(node)) return element.textContent.length;
  const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, offset);
  return range.toString().length;
}
