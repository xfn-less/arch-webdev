// ==UserScript==
// @name         Telegram File Note
// @namespace    local.telegram.file-note
// @version      0.12.0
// @description  Telegram 每群一份可编辑便签；复用 Text Vault 加密保存
// @match        https://web.telegram.org/k/*
// @match        http://127.0.0.1:8787/*
// @match        http://localhost:8787/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// ==/UserScript==

(() => {
  'use strict';
  const DEFAULT_URL = 'http://127.0.0.1:8787/';
  const old = GM_getValue('tg-vault-links:v1', {});
  let baseUrl = GM_getValue('tg-vault-url:v2', old.baseUrl || DEFAULT_URL);
  const channel = origin => `tg-vault-note-bridge:${origin}`;

  // One unlocked vault tab handles requests, even with several vault tabs open.
  if (location.hostname !== 'web.telegram.org') {
    if (location.origin !== new URL(baseUrl).origin) return;
    window.addEventListener('text-vault:telegram-ready', () => {
      navigator.locks.request('text-vault-telegram-bridge', async () => {
        const key = channel(location.origin);
        const listener = GM_addValueChangeListener(`${key}:request`, (_key, _old, request) => {
          if (!request || Date.now() - request.at > 15000) return;
          window.dispatchEvent(new CustomEvent('text-vault:telegram-request', {detail: JSON.stringify(request)}));
          if (GM_getValue(`${key}:request`, null)?.id === request.id) GM_deleteValue(`${key}:request`);
        });
        window.addEventListener('text-vault:telegram-response', event => {
          try {
            const responseKey = `${key}:response:${JSON.parse(event.detail).id}`;
            GM_setValue(responseKey, JSON.parse(event.detail));
            setTimeout(() => GM_deleteValue(responseKey), 20000);
          } catch {}
        });
        await new Promise(resolve => window.addEventListener('pagehide', resolve, {once: true}));
        GM_removeValueChangeListener(listener);
      });
    }, {once: true});
    return;
  }

  let host, panel, toggle, editor, viewer, status, overview;
  let currentTgId = '';
  let collapsed = GM_getValue('tg-vault-panel-collapsed', false);
  const drafts = new Map();
  function stateFor(tgId) {
    if (!drafts.has(tgId)) drafts.set(tgId, {text: '', base: null, dirty: false, loading: false, saving: false, editing: false, error: false, message: ''});
    return drafts.get(tgId);
  }
  function getCurrentTgId() {
    // Keep Telegram's hash identifier as text, including @username identifiers.
    const hash = location.hash.slice(1);
    try { return decodeURIComponent(hash); } catch { return hash; }
  }
  function getCurrentChatTitle() {
    const node = [...document.querySelectorAll('#column-center .chat-info .peer-title, .chat-info .peer-title')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    });
    if (!node) return '';
    const copy = node.cloneNode(true);
    for (const image of copy.querySelectorAll('img[alt]')) image.replaceWith(document.createTextNode(image.alt));
    return (copy.textContent || '').replace(/[\r\n]+/g, ' ').trim();
  }
  function searchUrl(query) {
    const url = new URL('index.html', baseUrl);
    url.hash = new URLSearchParams({q: query}).toString();
    return url.href;
  }
  function linkedText(text) {
    return textLinks(text).map(part => {
      if (part.type === 'text') return document.createTextNode(part.text);
      const link = document.createElement('a'); link.textContent = part.text;
      link.href = part.type === 'search' ? searchUrl(part.query) : part.href;
      link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.addEventListener('click', event => { event.preventDefault(); GM_openInTab(link.href, {active: !event.ctrlKey && !event.metaKey, insert: true}); });
      return link;
    });
  }
// Recognize links in plain text; callers create DOM nodes with textContent.
// No HTML or Markdown parser is involved.
function textLinks(text) {
  const parts = [];
  const pattern = /\[\[([^\]\n]+)\]\]|(?:https?:\/\/|(?<![\w@.])www\.)[^\s<>"'\[\]，。；！？]+/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    parts.push({type: 'text', text: text.slice(cursor, start)});
    if (match[1] !== undefined) {
      const query = match[1].trim();
      parts.push(query ? {type: 'search', text: match[0], query} : {type: 'text', text: match[0]});
      cursor = start + match[0].length;
      continue;
    }
    let url = match[0].replace(/[.,;!?，。；！？]+$/u, '');
    while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1);
    try {
      const parsed = new URL(url.startsWith('www.') ? `https://${url}` : url);
      if (!parsed.hostname) throw new Error('missing host');
      parts.push({type: 'url', text: url, href: parsed.href});
    } catch { parts.push({type: 'text', text: url}); }
    cursor = start + url.length;
  }
  parts.push({type: 'text', text: text.slice(cursor)});
  return parts.filter(part => part.text);
}

function textOffsetAtPoint(element, x, y) {
  const position = document.caretPositionFromPoint?.(x, y, {shadowRoots: [element.getRootNode()]});
  const legacy = !position && document.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? legacy?.startContainer;
  const offset = position?.offset ?? legacy?.startOffset;
  if (!node || offset === undefined || !element.contains(node)) return element.textContent.length;
  const range = document.createRange(); range.selectNodeContents(element); range.setEnd(node, offset);
  return range.toString().length;
}

  function request(action, detail) {
    const key = channel(new URL(baseUrl).origin);
    const id = crypto.randomUUID();
    const responseKey = `${key}:response:${id}`;
    return new Promise((resolve, reject) => {
      const listener = GM_addValueChangeListener(responseKey, (_key, _old, response) => {
        if (!response || response.id !== id) return;
        clearTimeout(timer); GM_removeValueChangeListener(listener); GM_deleteValue(responseKey);
        if (response.error) reject(Object.assign(new Error(response.error), {query: response.query, count: response.count}));
        else if (!response.note || response.note.tgId !== detail.tgId || typeof response.note.text !== 'string') reject(new Error('返回内容无效，请刷新 Text Vault 页面'));
        else if (typeof response.note.editorText !== 'string') reject(new Error('Text Vault 标签页仍在运行旧版桥接。请保存其中的编辑，关闭其他 Text Vault 标签页，再刷新并解锁一个页面。'));
        else resolve({...response.note, text: response.note.editorText});
      });
      const timer = setTimeout(() => {
        GM_removeValueChangeListener(listener);
        if (GM_getValue(`${key}:request`, null)?.id === id) GM_deleteValue(`${key}:request`);
        reject(new Error('连接超时，请打开并解锁 Text Vault；若已打开，请刷新该页面'));
      }, action === 'note-write' ? 15000 : 6000);
      GM_setValue(`${key}:request`, {id, action, format: 'plain-text', tgTitle: detail.tgId === getCurrentTgId() ? getCurrentChatTitle() : '', at: Date.now(), ...detail});
    });
  }
  function render() {
    if (!panel) return;
    const state = currentTgId ? stateFor(currentTgId) : null;
    editor.hidden = !currentTgId || !state?.editing;
    viewer.hidden = !currentTgId || Boolean(state?.editing);
    const displayedText = state?.text ?? '';
    if (viewer.textContent !== displayedText) {
      viewer.replaceChildren(...linkedText(displayedText));
    }
    overview.hidden = Boolean(currentTgId);
    if (editor.value !== (state?.text ?? '')) editor.value = state?.text ?? '';
    editor.readOnly = !state?.base || state.loading || !state.editing;
    editor.placeholder = currentTgId ? '点击编辑' : '';
    panel.dataset.editing = String(Boolean(state?.editing));
    panel.dataset.state = state?.error ? 'failed' : state?.saving ? 'saving' : state?.editing || [...drafts.values()].some(value => value.dirty) ? 'editing' : 'clean';
    panel.setAttribute('aria-label', currentTgId ? `${currentTgId} · 便签` : '群便签');
    status.textContent = state?.error ? state.message : '';
    status.hidden = !state?.error;
    panel.hidden = collapsed;
    toggle.textContent = collapsed ? '‹' : '›';
    toggle.title = collapsed ? '展开便签' : '收起便签';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.style.right = collapsed ? '0' : 'min(400px, calc(100vw - 42px))';
  }
  async function loadNote(tgId, discard = false) {
    if (!tgId) return;
    const state = stateFor(tgId);
    if (state.loading || state.saving || (state.dirty && !discard)) return;
    state.loading = true;
    state.message = '读取中…'; state.error = false; render();
    try {
      const note = await request('note-read', {tgId});
      state.base = note; state.text = note.text; state.dirty = false; state.message = ''; state.redirected = false;
    } catch (error) {
      state.message = error.message; state.error = true;
      if (error.count > 1 && typeof error.query === 'string') {
        state.base = null; state.text = ''; state.editing = false;
        if (tgId === currentTgId && !state.redirected) {
          state.redirected = true;
          GM_openInTab(searchUrl(error.query), {active: true, insert: true});
        }
      }
    }
    finally { state.loading = false; render(); }
  }
  async function saveNote() {
    const tgId = currentTgId;
    if (!tgId) return;
    const state = stateFor(tgId);
    if (!state.base || state.saving || state.loading) return;
    if (!state.dirty) { state.editing = false; render(); return; }
    const text = state.text;
    state.saving = true; state.error = false; state.message = '保存中…'; render();
    const applySaved = note => {
      state.base = note; state.error = false;
      if (state.text === text) state.text = note.text;
      state.dirty = state.text !== note.text;
      if (!state.dirty) state.editing = false;
      state.message = state.dirty ? '已保存上一版，当前还有修改未保存' : '已保存';
    };
    try {
      applySaved(await request('note-write', {tgId, text, expected: {id: state.base.id, revision: state.base.revision}}));
    } catch (error) {
      state.error = true;
      // The commit may have succeeded even if its response was lost.
      try {
        const note = await request('note-read', {tgId});
        if (note.text === text) applySaved(note);
        else state.message = `${error.message}。草稿已保留；可复制草稿后用脚本菜单“重新读取便签”核对。`;
      } catch { state.message = `${error.message}。未确认保存，草稿已保留。`; }
    } finally { state.saving = false; render(); }
  }
  function watchChatChange() {
    const tgId = getCurrentTgId();
    if (tgId === currentTgId) return;
    currentTgId = tgId;
    if (tgId) stateFor(tgId).redirected = false;
    render();
    if (tgId && !stateFor(tgId).dirty) loadNote(tgId);
  }
  // Run before Telegram's document shortcuts. Native textarea editing still works.
  for (const type of ['keydown', 'keyup', 'keypress']) window.addEventListener(type, event => {
    if (!host || !event.composedPath().includes(host)) return;
    event.stopImmediatePropagation();
    if (type === 'keydown' && event.key === 'Enter' && event.composedPath().includes(viewer) && currentTgId) {
      event.preventDefault(); viewer.click(); return;
    }
    if (type === 'keydown' && !event.isComposing && (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's'))) {
      event.preventDefault(); saveNote();
    }
  }, true);
  window.addEventListener('beforeunload', event => {
    if ([...drafts.values()].some(state => state.dirty || state.saving)) { event.preventDefault(); event.returnValue = ''; }
  });
  function start() {
    if (document.getElementById('tg-vault-link')) return;
    host = document.createElement('div'); host.id = 'tg-vault-link';
    Object.assign(host.style, {position: 'fixed', right: '0', top: '0', zIndex: '2147483647'});
    const root = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = `
      :host{font:14px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#e0e2dc}
      [hidden]{display:none!important}
      .panel{position:fixed;right:0;top:8px;bottom:8px;width:min(400px,calc(100vw - 42px));display:flex;flex-direction:column;background:rgba(41,45,43,.97);backdrop-filter:blur(12px);border-top:4px solid transparent;box-sizing:border-box;box-shadow:-3px 0 14px #0002}
      .panel[data-state=editing]{border-top-color:#70927b}
      .panel[data-state=saving]{border-top-color:#5f6862}
      .panel[data-state=failed]{border-top-color:#a96964}
      .editor{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:0;outline:0;padding:20px;color:inherit;background:transparent;font:inherit;overflow-wrap:anywhere;overscroll-behavior:contain;cursor:text}
      .viewer{flex:1;min-height:0;box-sizing:border-box;overflow:auto;padding:20px;white-space:pre-wrap;overflow-wrap:anywhere;cursor:text;overscroll-behavior:contain}
      .viewer a{color:#a6bbaa;text-decoration:underline;text-underline-offset:3px}
      .panel[data-editing=true] .editor{background:rgba(109,124,113,.22)}
      .editor::placeholder{color:#8e978f}
      .error{padding:10px 20px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;color:#c3aaa5}
      .toggle{position:fixed;top:48%;padding:8px 5px;border:0;border-radius:2px 0 0 2px;background:#393f3bd9;color:#8e978f;font:18px monospace;cursor:pointer}
      .toggle:hover{color:#e0e2dc}
      .overview{display:block;margin:24px 18px;color:#a6bbaa;text-decoration:none;padding:12px 16px;border-left:3px solid #73957e}
      .overview:hover{background:#6d7c7126}
      ::selection{background:#73957e88;color:#e0e2dc}
    `;
    panel = document.createElement('aside'); panel.className = 'panel';
    viewer = document.createElement('div'); viewer.className = 'viewer'; viewer.setAttribute('aria-label', '便签内容'); viewer.tabIndex = 0;
    const beginEdit = event => {
      if (event.target.closest('a')) return;
      if (!currentTgId || window.getSelection()?.toString()) return;
      const state = stateFor(currentTgId);
      if (!state.base || state.loading) return;
      const offset = event.detail ? textOffsetAtPoint(viewer, event.clientX, event.clientY) : state.text.length;
      const scrollTop = viewer.scrollTop;
      state.editing = true; state.message = ''; state.error = false; render(); editor.focus();
      editor.setSelectionRange(offset, offset); editor.scrollTop = scrollTop;
    };
    viewer.addEventListener('click', beginEdit);
    editor = document.createElement('textarea'); editor.className = 'editor'; editor.spellcheck = false; editor.setAttribute('aria-label', '便签内容');
    editor.addEventListener('click', () => {
      if (!currentTgId) return;
      const state = stateFor(currentTgId);
      if (!state.base || state.loading) return;
      state.editing = true; state.message = ''; state.error = false; render(); editor.focus();
    });
    document.addEventListener('pointerdown', event => {
      if (!currentTgId || !stateFor(currentTgId).editing) return;
      if (event.composedPath().includes(host)) return;
      saveNote();
    }, true);
    editor.addEventListener('input', () => {
      if (!currentTgId) return;
      const state = stateFor(currentTgId); if (!state.base) return;
      state.text = editor.value; state.dirty = state.text !== state.base.text; state.message = ''; state.error = false; render();
    });
    status = document.createElement('div'); status.className = 'error'; status.setAttribute('role', 'status');
    overview = document.createElement('a');
    overview.className = 'overview'; overview.textContent = '全部群便签 ↗';
    const overviewUrl = new URL('index.html', baseUrl);
    overviewUrl.hash = new URLSearchParams({q: 'tgId'}).toString();
    overview.href = overviewUrl.href; overview.target = '_blank'; overview.rel = 'noopener noreferrer';
    overview.addEventListener('click', event => { event.preventDefault(); GM_openInTab(overview.href, {active: true, insert: true}); });
    panel.append(overview, viewer, editor, status);
    toggle = document.createElement('button'); toggle.className = 'toggle'; toggle.setAttribute('aria-label', '收起或展开便签');
    toggle.onclick = () => { collapsed = !collapsed; GM_setValue('tg-vault-panel-collapsed', collapsed); render(); };
    root.append(style, panel, toggle); document.body.append(host);
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick', 'input', 'beforeinput', 'compositionstart', 'compositionupdate', 'compositionend']) root.addEventListener(type, event => event.stopPropagation());
    render(); watchChatChange();
    setInterval(watchChatChange, 300);
    setInterval(() => {
      if (!collapsed && currentTgId && !stateFor(currentTgId).dirty && root.activeElement !== editor) loadNote(currentTgId);
    }, 5000);
    GM_registerMenuCommand('重新读取便签', () => {
      if (!currentTgId) return;
      if (stateFor(currentTgId).dirty && !confirm('重新读取会替换草稿，请先复制要保留的内容。继续吗？')) return;
      loadNote(currentTgId, true);
    });
    GM_registerMenuCommand('打开 Text Vault', () => GM_openInTab(baseUrl, {active: true, insert: true}));
    GM_registerMenuCommand('设置 Text Vault 地址', () => {
      const value = prompt('Text Vault 地址；更换域名后也需在脚本 @match 中添加该地址', baseUrl);
      if (value === null) return;
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('地址无效');
        url.hash = '';
        if ([...drafts.values()].some(state => state.dirty)) { alert('请先保存草稿再更换地址'); return; }
        GM_setValue('tg-vault-url:v2', url.href); location.reload();
      } catch (error) { alert(error.message); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
})();
