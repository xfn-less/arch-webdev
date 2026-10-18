import van from "../../vendor/van-1.6.1.js";
import {buildAgenda} from "../core/agenda.js";
import {runQuery} from "../core/query.js";
import {createEntry} from "../model.js";
import {parseTotpEntry, generateTotp} from "../core/totp.js";

const {button, div, span, textarea} = van.tags;

// The river owns unfinished UI state. Durable text enters the repository only
// when a click outside the editor commits the single active draft.
export function createRiverView({root, repository, saver, sync, queryLocation, now = () => new Date()}) {
  let query = queryLocation.read();
  let orderBy = queryLocation.readOrder();
  let editing = null;
  let selectedText = "";
  let gesture = null;
  let gestureHandled = false;
  let ignoreEntryClick = false;
  let destroyed = false;
  const status = div({class: "sync-status", "data-state": "clean", role: "status", "aria-label": "已保存"});
  const river = div({class: "river", role: "list", "aria-label": "条目河流"});
  const search = textarea({class: "search-input", rows: 1, spellcheck: false, autocomplete: "off", "aria-label": "搜索", placeholder: "搜索"});
  const searchTrigger = button({type: "button", class: "search-trigger", "aria-label": "搜索，打开时点击清空，上滑新增，左滑切换排列"});
  const searchControl = div({class: "search-control", "data-open": String(Boolean(query.trim()))}, searchTrigger, search);
  const selectionSearch = button({type: "button", class: "selection-search", hidden: true, "aria-label": "在新标签搜索选中文字"});
  const shell = div({class: "river-shell"}, status, river, searchControl, selectionSearch);

  const cleanups = [
    repository.subscribe(renderEntries),
    saver.subscribe(renderStatus),
    sync.subscribe(renderStatus),
    queryLocation.subscribe(onLocationChange),
  ];
  search.addEventListener("input", onSearch);
  search.addEventListener("keydown", onSearchKeydown);
  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onDocumentKeydown);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("focus", onWindowFocus);
  window.addEventListener("beforeunload", onBeforeUnload);
  selectionSearch.addEventListener("pointerdown", event => event.preventDefault());
  selectionSearch.addEventListener("click", openSelectionSearch);
  searchTrigger.addEventListener("click", onTriggerClick);
  searchTrigger.addEventListener("pointerdown", onTriggerPointerDown);
  searchTrigger.addEventListener("pointerup", onTriggerPointerUp);
  searchTrigger.addEventListener("pointercancel", cancelGesture);
  searchTrigger.addEventListener("contextmenu", event => event.preventDefault());
  searchControl.addEventListener("transitionend", onSearchTransitionEnd);

  root.replaceChildren(shell);
  search.value = query;
  updateSearchSpace();
  renderEntries();
  renderStatus();

  function entries() {
    return runQuery({type: "full-text", text: query, orderBy, direction: "asc"}, repository.values());
  }

  function renderEntries() {
    if (destroyed) return;
    const oldEditor = river.querySelector(".entry-editor");
    const caret = oldEditor && {start: oldEditor.selectionStart, end: oldEditor.selectionEnd};
    const rows = renderAgenda(entries());
    river.replaceChildren(...rows);
    if (editing) queueMicrotask(() => {
      const editor = river.querySelector(".entry-editor");
      if (!editor) return;
      // Existing entries start at their rendered height, so entering edit mode
      // does not move the river. New entries have no rendered height to inherit.
      if (!editing.initialHeight) grow(editor);
      editor.focus();
      const start = caret?.start ?? editing.initialCaret ?? editor.value.length;
      editor.setSelectionRange(start, caret?.end ?? start);
    });
  }

  function renderAgenda(filteredEntries) {
    const instant = now();
    const agenda = buildAgenda(filteredEntries, instant);
    const today = dateKey(instant);
    const rows = [];
    if (orderBy === "updatedAt") {
      rows.push(...filteredEntries.map(renderEntry));
      if (editing?.isNew) rows.push(renderEditorRow("new"));
    } else {
      for (const day of agenda.days) {
        if (query.trim() && !day.entries.length) continue;
        rows.push(renderDateHeading(day.date, day.date === today));
        rows.push(...day.entries.map(renderEntry));
        if (day.date === today && editing?.isNew) rows.push(renderEditorRow("new"));
      }
    }
    // Future references use the same date-and-entry grammar as the river.
    // A query already contains those entries, so its result does not repeat them.
    if (!query.trim() && agenda.reminders.length) {
      const futureRows = [];
      let lastDate = "";
      for (const reminder of agenda.reminders) {
        if (orderBy === "createdAt" && reminder.date !== lastDate) {
          futureRows.push(renderDateHeading(reminder.date, false));
          lastDate = reminder.date;
        }
        futureRows.push(renderReminderEntry(reminder.entry));
      }
      rows.push(div({class: "agenda-future"},
        button({type: "button", class: "future-heading", "aria-label": "新增条目", onclick: startAdd}),
        ...futureRows));
    }
    return rows;
  }

  function renderEntry(entry) {
    if (editing?.id === entry.id && editing.surface !== "reminder") return renderEditorRow(entry.id);
    return row(entry.id, div({class: "entry-text", onclick: event => {
      if (!window.getSelection()?.isCollapsed) return;
      if (ignoreEntryClick) return;
      startEdit(entry, event.currentTarget, textOffsetAtPoint(event.currentTarget, event.clientX, event.clientY));
    }}, ...highlightDateMarkers(cleanText(entry.text) || " ")), "", entry.text);
  }

  function renderReminderEntry(entry) {
    if (editing?.id === entry.id && editing.surface === "reminder") return renderEditorRow(entry.id, "reminder-entry");
    return row(entry.id, div({class: "entry-text reminder-text", tabindex: 0, onclick: event => {
      if (!window.getSelection()?.isCollapsed) return;
      if (ignoreEntryClick) return;
      startEdit(entry, event.currentTarget, textOffsetAtPoint(event.currentTarget, event.clientX, event.clientY), "reminder");
    }}, ...highlightDateMarkers(entry.text || " ")), "reminder-entry", entry.text);
  }

  function totpButton(text) {
    const parsed = parseTotpEntry(text);
    if (!parsed) return null;
    if (parsed.error) return span({role: "status"}, parsed.error);
    return button({type: "button", "aria-label": "复制验证码", onclick: async event => {
      const target = event.currentTarget;
      target.disabled = true;
      try {
        const time = () => new Date(now()).getTime();
        const counter = () => Math.floor(time() / 1000 / parsed.config.period);
        let result = await generateTotp(parsed.config, time());
        if (result.counter !== counter()) result = await generateTotp(parsed.config, time());
        if (result.counter !== counter()) throw new Error("expired");
        if (!target.isConnected) return;
        await navigator.clipboard.writeText(result.code);
        target.textContent = "已复制";
      } catch { target.textContent = "复制失败，请重试"; }
      finally { target.disabled = false; }
    }}, "复制验证码");
  }

  function renderEditorRow(id, extraClass = "") {
    const editor = textarea({
      class: "entry-editor", "data-editor-id": id, "aria-label": "编辑条目", spellcheck: false, rows: 1,
      value: editing.draft,
      style: editing.initialHeight ? `height:${editing.initialHeight}px` : "",
      oninput: event => { editing.draft = event.target.value; grow(event.target); renderStatus(); },
      onkeydown: event => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          const text = event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd).trim();
          if (text) {
            event.preventDefault();
            openTextSearch(text);
          }
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        void commitEdit();
      },
    });
    return row(id, editor, extraClass);
  }

  function row(id, body, extraClass = "", text = "") {
    const copy = totpButton(text);
    if (copy) body = div(body, copy);
    const attributes = {class: `river-entry ${extraClass}`.trim(), role: "listitem"};
    if (id) attributes["data-entry-id"] = id;
    return div(attributes, span({class: "entry-marker", "aria-hidden": "true"}), body);
  }

  function startEdit(entry, source, initialCaret, surface = "river") {
    if (editing) return;
    editing = {id: entry.id, draft: entry.text, original: entry.text, isNew: false, initialHeight: source?.getBoundingClientRect().height || 0, initialCaret, surface};
    beginEditing();
  }

  function startAdd() {
    if (editing) return;
    editing = {id: "", draft: "", original: "", isNew: true};
    beginEditing();
    river.scrollTop = river.scrollHeight;
  }

  function beginEditing() {
    search.disabled = true;
    searchTrigger.disabled = true;
    if (!query.trim()) hideSearch();
    hideSelectionSearch();
    renderEntries();
    renderStatus();
  }

  async function commitEdit() {
    if (!editing) return;
    const finished = editing;
    const text = cleanText(finished.draft);
    editing = null;
    search.disabled = false;
    searchTrigger.disabled = false;

    let changed = false;
    if (finished.isNew && text) {
      const instant = now();
      const iso = instant instanceof Date ? instant.toISOString() : String(instant);
      repository.upsert({...createEntry({existingIDs: repository.knownIDs(), now: iso}), text, updatedAt: iso});
      changed = true;
    } else if (!finished.isNew && text !== finished.original) {
      repository.updateEntryText(finished.id, text);
      changed = true;
    }
    renderEntries();
    renderStatus();
    if (changed) try { await saver.save(); } catch {}
  }

  function onDocumentClick(event) {
    const editor = river.querySelector(".entry-editor");
    if (!editing || !editor || editor.contains(event.target)) return;

    // Commit the active entry before interpreting another surface.
    // Entry switching intentionally takes a second click, preventing an
    // outside-save gesture from also opening an unintended entry.
    const wantsEntry = event.target.closest?.(".river-entry");
    const wantsSearch = event.target.closest?.(".search-input");
    if (wantsEntry || wantsSearch) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (wantsEntry) {
      ignoreEntryClick = true;
      setTimeout(() => { ignoreEntryClick = false; }, 0);
    }
    void commitEdit();
    if (wantsSearch) showSearch();
  }

  function onDocumentKeydown(event) {
    if (event.isComposing || event.altKey) return;
    if (event.key === "Escape" && !editing && query.trim()) {
      event.preventDefault();
      clearSearch();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && selectedText) {
      event.preventDefault();
      openSelectionSearch();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.target.closest?.("textarea, input")) return;
    if (event.key === "/") {
      event.preventDefault();
      showSearch();
    } else if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      startAdd();
    }
  }

  function onSearchKeydown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    // Escape leaves one focus layer at a time. A populated query remains
    // visible after blur; the following document-level Escape clears it.
    if (query.trim()) search.blur();
    else hideSearch();
  }

  function showSearch() {
    if (editing) return;
    search.style.height = "48px";
    searchControl.dataset.open = "true";
    updateSearchSpace();
    queueMicrotask(() => {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    });
  }

  function hideSearch() {
    if (!query.trim() && query) {
      query = "";
      search.value = "";
      queryLocation.write("");
      renderEntries();
    }
    searchControl.dataset.open = "false";
    search.blur();
    search.style.height = "";
    updateSearchSpace();
  }

  function onTriggerClick(event) {
    if (gestureHandled) {
      event.preventDefault();
      gestureHandled = false;
      return;
    }
    if (searchControl.dataset.open === "true") clearSearch();
    else showSearch();
  }

  function onTriggerPointerDown(event) {
    if (searchTrigger.disabled) return;
    gesture = {id: event.pointerId, x: event.clientX, y: event.clientY};
    searchTrigger.setPointerCapture?.(event.pointerId);
  }

  function onTriggerPointerUp(event) {
    if (!gesture || gesture.id !== event.pointerId) return cancelGesture();
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gesture = null;
    if (dy < -32 && Math.abs(dy) > Math.abs(dx)) {
      markGestureHandled();
      startAdd();
    } else if (dx < -32 && Math.abs(dx) > Math.abs(dy)) {
      markGestureHandled();
      toggleOrder();
    }
  }

  function toggleOrder() {
    if (editing) return;
    orderBy = orderBy === "createdAt" ? "updatedAt" : "createdAt";
    queryLocation.writeOrder(orderBy);
    renderEntries();
  }

  function markGestureHandled() {
    gestureHandled = true;
    setTimeout(() => { gestureHandled = false; }, 400);
  }

  function onSearchTransitionEnd(event) {
    if (event.propertyName === "width" && searchControl.dataset.open === "true") {
      grow(search);
      updateSearchSpace();
    }
  }

  function cancelGesture() {
    gesture = null;
    gestureHandled = false;
  }

  function clearSearch() {
    query = "";
    search.value = "";
    search.style.height = "";
    searchControl.dataset.open = "false";
    queryLocation.write("");
    renderEntries();
    updateSearchSpace();
  }

  function updateSearchSpace() {
    queueMicrotask(() => shell.style.setProperty("--search-height", `${searchControl.getBoundingClientRect().height || 48}px`));
  }

  function onSearch() {
    if (editing) return;
    query = search.value;
    queryLocation.write(query);
    renderEntries();
    grow(search);
    updateSearchSpace();
  }

  function onLocationChange(value) {
    if (editing) return;
    query = value;
    orderBy = queryLocation.readOrder();
    search.value = value;
    searchControl.dataset.open = String(Boolean(query.trim()));
    renderEntries();
    updateSearchSpace();
  }

  function onSelectionChange() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return hideSelectionSearch();
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    const node = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
    if (!node?.closest?.(".entry-text")) return hideSelectionSearch();
    selectedText = selection.toString().trim();
    if (!selectedText) return hideSelectionSearch();
    const box = range.getBoundingClientRect();
    selectionSearch.style.left = `${Math.min(window.innerWidth - 42, Math.max(8, box.right + 6))}px`;
    selectionSearch.style.top = `${Math.min(window.innerHeight - 42, Math.max(8, box.bottom + 6))}px`;
    selectionSearch.hidden = false;
  }

  function openSelectionSearch() {
    if (selectedText) openTextSearch(selectedText);
    hideSelectionSearch();
  }

  function openTextSearch(text) {
    window.open(queryLocation.url(text), "_blank", "noopener");
  }

  function hideSelectionSearch() {
    selectedText = "";
    selectionSearch.hidden = true;
  }

  function renderStatus() {
    let state = "clean";
    if (repository.hasQuarantined() || repository.hasConflicts() || ["failed", "conflict"].includes(saver.status()) || ["failed", "conflict"].includes(sync.status())) state = "failed";
    else if (editing) state = "editing";
    else if (repository.hasPendingChanges() || ["dirty", "saving"].includes(saver.status())) state = "saving";
    status.dataset.state = state;
    status.setAttribute("aria-label", ({clean: "已保存", editing: "正在编辑", saving: "正在保存", failed: "同步失败"})[state]);
  }

  function onWindowFocus() { void sync.pull().catch(() => {}); }

  function onBeforeUnload(event) {
    if (!editing && !repository.hasPendingChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const cleanup of cleanups) cleanup();
    document.removeEventListener("click", onDocumentClick, true);
    document.removeEventListener("keydown", onDocumentKeydown);
    document.removeEventListener("selectionchange", onSelectionChange);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("beforeunload", onBeforeUnload);
    searchControl.removeEventListener("transitionend", onSearchTransitionEnd);
    cancelGesture();
  }

  return destroy;
}

function renderDateHeading(key, today) {
  const [year, month, day] = key.split("-").map(Number);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(year, month - 1, day).getDay()];
  return div({class: `date-heading${today ? " today" : ""}`},
    div({class: "date-year"}, year),
    div({class: "date-dot", "aria-hidden": "true"}, "·"),
    div({class: "date-main"}, `${month}月${day}日`),
    div({class: "date-dot", "aria-hidden": "true"}, "·"),
    div({class: "date-meta"}, weekday));
}

function dateKey(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

// Date markers remain ordinary text data. The view only decorates their
// rendered ranges, so copying and editing still expose the original text.
function highlightDateMarkers(text) {
  const nodes = [];
  const pattern = /(?:^|[^\p{L}\p{N}_])(@(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}|\d{1,2}))(?![\d-])/gu;
  let cursor = 0;
  for (const match of String(text).matchAll(pattern)) {
    const token = match[1];
    const start = match.index + match[0].length - token.length;
    nodes.push(text.slice(cursor, start), span({class: "date-token"}, token));
    cursor = start + token.length;
  }
  nodes.push(text.slice(cursor));
  return nodes;
}

// Stored entries have no meaningful whitespace outside their first and last
// visible character. Interior spaces and blank lines remain untouched.
function cleanText(text) {
  return text.trim();
}

function grow(element) {
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

// Resolve the click before replacing display text with its textarea. Safari
// exposes the Range form while Chromium exposes CaretPosition.
function textOffsetAtPoint(element, x, y) {
  const position = document.caretPositionFromPoint?.(x, y);
  const legacy = !position && document.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? legacy?.startContainer;
  const offset = position?.offset ?? legacy?.startOffset;
  if (!node || offset === undefined || !element.contains(node)) return element.textContent.length;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(node, offset);
  return range.toString().length;
}
