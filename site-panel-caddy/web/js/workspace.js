import van from "../vendor/van-1.6.1.js";
import { api } from "./api.js";
import { createCodeEditor, modeForPath } from "./editor.js";
import { action, field, icon, modal, separator } from "./ui.js";
import { listDir, formatBytes } from "./files.js";
import { createSSLPane } from "./ssl.js";
const {
  button,
  div,
  form,
  input,
  option,
  p,
  pre,
  section,
  select,
  small,
  span,
  table,
  tbody,
  td,
  th,
  thead,
  tr,
} = van.tags;

export function createWorkspace(
  site,
  {
    onError,
    notify,
    onUpdated,
    onDeploy,
    siteTasks = () => [],
    selectedTask,
    logText,
    logError,
    logLoading,
    logTime,
    onChooseTask,
    onLoadLogs,
    onRefreshTasks,
    taskName = (t) => t.id || "任务",
    timeLabel = () => "",
    statusBadge = (s) => span(s),
    downloadLog,
  },
) {
  const files = van.state([]),
    publishPath = van.state(site.publish_path || "site"),
    cwd = van.state(""),
    selected = van.state([]),
    pane = van.state("ssl"),
    opened = van.state([]),
    active = van.state(""),
    fileStatus = van.state("正在读取主控文件…"),
    fileFocus = van.state("browser");
  const docs = new Map();
  let disposed = false,
    fileEpoch = 0,
    openEpoch = 0;
  const act = (text, fn, glyph, kind = "", disabled) =>
    action(text, fn, { glyph, kind, onError, disabled });
  const hosts = div({ class: "editor-hosts" });
  const currentDoc = () => docs.get(active.val);
  const hasDirty = () => [...docs.values()].some((d) => d.dirty.val);
  const hasSaving = () => [...docs.values()].some((d) => d.saving.val);
  const updateDirty = (d) => {
    if (d.control)
      d.dirty.val = !d.existing || d.control.getValue() !== d.saved;
  };
  const beforeUnload = (event) => {
    if (hasDirty() || hasSaving()) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  window.addEventListener("beforeunload", beforeUnload);

  async function refreshFiles() {
    const epoch = ++fileEpoch;
    try {
      const list = await api.files(site.id);
      if (disposed || epoch !== fileEpoch) return;
      const entries = Array.isArray(list) ? list : list?.files || [];
      files.val = entries;
      if (!Array.isArray(list) && list?.publish_path !== undefined) {
        publishPath.val = list.publish_path;
        site.publish_path = list.publish_path;
      }
      if (cwd.val) {
        const still = entries.some(
          (f) => f.path === cwd.val || f.path.startsWith(cwd.val + "/"),
        );
        if (!still) cwd.val = "";
      }
      selected.val = selected.val.filter((path) =>
        entries.some((f) => f.path === path),
      );
      fileStatus.val = "";
    } catch (error) {
      if (!disposed && epoch === fileEpoch) {
        fileStatus.val = error.message;
        throw error;
      }
    }
  }
  function activate(path) {
    active.val = path;
    for (const d of docs.values()) d.host.hidden = d.path !== path;
    if (path) fileFocus.val = "editor";
    docs.get(path)?.control?.focus();
  }
  function closeDoc(d, force = false) {
    if (!force && d.saving.val) {
      notify("文件正在保存，请稍候", "warning");
      return false;
    }
    if (
      !force &&
      d.dirty.val &&
      !confirm(`“${d.path}”有未保存的修改，确定放弃吗？`)
    )
      return false;
    d.closed = true;
    d.control?.destroy();
    d.host.remove();
    docs.delete(d.path);
    opened.val = [...docs.values()];
    if (active.val === d.path) {
      const next = opened.val.at(-1)?.path || "";
      activate(next);
      if (!next) fileFocus.val = "browser";
    }
    return true;
  }
  async function saveDoc(d) {
    if (!d?.control || d.saving.val || d.closed) return;
    const text = d.control.getValue();
    d.saving.val = true;
    d.status.val = "正在保存…";
    try {
      await api.write(site.id, d.path, text);
      if (disposed || d.closed) return;
      d.saved = text;
      d.existing = true;
      updateDirty(d);
      d.status.val = "已保存";
      notify(`已保存 ${d.path}`, "success");
      await refreshFiles();
    } catch (error) {
      if (!disposed) {
        d.status.val = error.message;
        onError(error);
      }
    } finally {
      d.saving.val = false;
    }
  }
  function openDocument(path, value, existing) {
    if (disposed) return;
    if (docs.has(path)) {
      activate(path);
      return;
    }
    const d = {
      path,
      existing,
      saved: value,
      dirty: van.state(!existing),
      saving: van.state(false),
      ready: van.state(false),
      status: van.state("正在加载编辑器…"),
      host: div({ class: "code-editor embedded-editor", "data-path": path }),
      closed: false,
    };
    docs.set(path, d);
    opened.val = [...docs.values()];
    hosts.append(d.host);
    activate(path);
    createCodeEditor(d.host, {
      path,
      value,
      onSave: () => saveDoc(d),
      onChange: () => updateDirty(d),
    })
      .then((control) => {
        if (disposed || d.closed) {
          control.destroy();
          return;
        }
        d.control = control;
        d.ready.val = true;
        d.status.val = existing ? "已保存" : "未保存";
        if (active.val === path && pane.val === "files") control.focus();
      })
      .catch((error) => {
        if (!disposed && !d.closed) {
          d.status.val = error.message;
          onError(error);
        }
      });
  }
  // Requests can complete out of order. Each document is keyed by path and a late
  // response must never overwrite a document opened/edited in the meantime.
  const reading = new Map();
  async function openFile(file) {
    const epoch = ++openEpoch;
    pane.val = "files";
    if (docs.has(file.path)) {
      activate(file.path);
      return;
    }
    if (file.size > 1048576) {
      notify("大文件仅保存和部署，不在文本编辑器中打开", "warning");
      return;
    }
    const pending = reading.get(file.path) || api.read(site.id, file.path);
    reading.set(file.path, pending);
    try {
      const text = await pending;
      if (!disposed && epoch === openEpoch && !docs.has(file.path))
        openDocument(file.path, text, true);
    } finally {
      if (reading.get(file.path) === pending) reading.delete(file.path);
    }
  }
  function validRelPath(name) {
    return (
      !!name &&
      !name.startsWith("/") &&
      !name.includes("\\") &&
      !name.split("/").some((x) => !x || x === "." || x === "..")
    );
  }
  async function writeOne(path, blob, {overwriteAsk = true} = {}) {
    const open = docs.get(path);
    if (open?.dirty.val || open?.saving.val) {
      throw new Error(`${path} 有未保存修改，请先处理`);
    }
    if (
      overwriteAsk &&
      files.val.some((f) => f.path === path && !f.dir) &&
      !confirm(`覆盖主控中的“${path}”？`)
    ) {
      return false;
    }
    await api.write(site.id, path, blob);
    if (open) closeDoc(open, true);
    return true;
  }
  function newFolder() {
    modal("新建目录", (close) => {
      const path = input({
        required: true,
        value: cwd.val ? cwd.val + "/" : "",
        placeholder: "例如 assets/img",
      });
      const error = van.state("");
      return form(
        {
          onsubmit: async (event) => {
            event.preventDefault();
            const name = path.value.trim().replace(/^\/+|\/+$/g, "");
            if (!validRelPath(name)) {
              error.val = "请使用站点内的相对路径";
              return;
            }
            try {
              await api.mkdir(site.id, name);
              close();
              await refreshFiles();
              notify("目录已创建", "success");
            } catch (e) {
              error.val = e.message;
              onError(e);
            }
          },
        },
        field("目录相对路径", path),
        p({ class: "form-error", role: "alert" }, () => error.val),
        button({ type: "submit", class: "btn primary" }, "创建"),
      );
    });
  }
  function newFile() {
    modal("新建文本文件", (close) => {
      const base = cwd.val ? cwd.val + "/" : "";
      const defName = files.val.some((f) => f.path === base + "index.html")
        ? "untitled.html"
        : "index.html";
      const path = input({
        required: true,
        value: base + defName,
        placeholder: "例如 index.html 或 assets/app.js",
      });
      const error = van.state("");
      return form(
        {
          onsubmit: (event) => {
            event.preventDefault();
            const name = path.value.trim();
            if (
              !name ||
              name.startsWith("/") ||
              name.split("/").some((x) => !x || x === "." || x === "..") ||
              name.includes("\\")
            ) {
              error.val = "请使用站点内的相对路径";
              return;
            }
            if (files.val.some((f) => f.path === name) || docs.has(name)) {
              error.val = "同名文件已经存在，请直接打开或换一个名称";
              return;
            }
            const value =
              modeForPath(name) === "html"
                ? '<!doctype html>\n<meta charset="utf-8">\n<h1>站点部署成功</h1>\n'
                : "";
            close();
            openEpoch++;
            pane.val = "files";
            openDocument(name, value, false);
          },
        },
        field("文件相对路径", path, "此时只打开草稿，点击保存才会写入主控。"),
        p({ class: "form-error", role: "alert" }, () => error.val),
        button({ type: "submit", class: "btn primary" }, "创建并编辑"),
      );
    });
  }
  function publishKey() {
    return String(publishPath.val || "").replace(/^\/+|\/+$/g, "");
  }
  async function savePublishPath() {
    const next = publishKey();
    const result = await api.updateSite(site.id, {
      name: site.name,
      domains: site.domains || [],
      port: site.port || 0,
      cert: site.cert || "off",
      mode: site.mode || "static",
      upstreams: site.upstreams || [],
      proxies: site.proxies || [],
      redir_https: site.redir_https,
      publish_path: next,
    });
    Object.assign(site, result);
    publishPath.val = result.publish_path ?? next;
    notify(publishPath.val ? `站点目录：${publishPath.val}/` : "站点目录：根目录", "success");
    await refreshFiles();
  }
  function archiveBaseName(name) {
    let base = String(name || "")
      .split(/[/\\]/)
      .pop();
    base = base
      .replace(/\.tar\.gz$/i, "")
      .replace(/\.tar\.bz2$/i, "")
      .replace(/\.tgz$/i, "")
      .replace(/\.tbz2$/i, "")
      .replace(/\.tar$/i, "")
      .replace(/\.zip$/i, "")
      .trim();
    return base && validRelPath(base) ? base : "upload";
  }
  function upload() {
    let uploading = false;
    modal(
      "上传到主控",
      (close) => {
        const mode = van.state("files");
        const unpackMode = van.state("folder"); // folder | spread
        const filesInput = input({ type: "file", multiple: true });
        const folderInput = input({
          type: "file",
          webkitdirectory: true,
          directory: true,
        });
        const syncArchiveName = () => {
          const f = archiveInput.files?.[0];
          if (!f) return;
          if (unpackMode.val === "folder" && !dest.value.trim()) {
            dest.value = archiveBaseName(f.name);
          }
        };
        const archiveInput = input({
          type: "file",
          accept:
            ".zip,.tar,.tar.gz,.tgz,.tar.bz2,.tbz2,application/zip,application/gzip,application/x-tar,application/x-gzip",
          onchange: syncArchiveName,
        });
        const dest = input({
          placeholder: "例如 dist 或 web",
          value: "",
        });
        const busy = van.state(false),
          status = van.state("");
        const pick = () =>
          mode.val === "folder"
            ? folderInput
            : mode.val === "archive"
              ? archiveInput
              : filesInput;
        return form(
          {
            onsubmit: async (event) => {
              event.preventDefault();
              if (busy.val) return;
              const chosen = [...(pick().files || [])];
              if (!chosen.length) {
                status.val = "请先选择文件";
                return;
              }
              let prefix = dest.value.trim().replace(/^\/+|\/+$/g, "");
              if (mode.val === "archive") {
                if (unpackMode.val === "folder") {
                  if (!prefix) prefix = archiveBaseName(chosen[0].name);
                  dest.value = prefix;
                } else {
                  prefix = "";
                }
              }
              if (mode.val !== "archive" && cwd.val) {
                prefix = prefix ? joinPath(cwd.val, prefix) : cwd.val;
              } else if (
                mode.val === "archive" &&
                unpackMode.val === "folder" &&
                cwd.val
              ) {
                prefix = joinPath(cwd.val, prefix);
              } else if (
                mode.val === "archive" &&
                unpackMode.val === "spread" &&
                cwd.val
              ) {
                prefix = cwd.val;
              }
              if (prefix && !validRelPath(prefix)) {
                status.val = "目标目录路径无效";
                return;
              }
              uploading = true;
              busy.val = true;
              try {
                if (mode.val === "archive") {
                  status.val = prefix
                    ? `正在解压到 ${prefix}/ …`
                    : "正在铺开到当前目录…";
                  const result = await api.unzip(
                    site.id,
                    chosen[0],
                    prefix,
                    chosen[0].name,
                  );
                  const where = prefix ? `${prefix}/` : "当前目录";
                  const strip = result?.stripped
                    ? `，已去掉内层 ${result.stripped}/`
                    : "";
                  const fmt = result?.format ? `（${result.format}）` : "";
                  notify(`已解压到 ${where}${strip}${fmt}`, "success");
                } else {
                  let done = 0;
                  for (const file of chosen) {
                    const rel =
                      mode.val === "folder"
                        ? file.webkitRelativePath || file.name
                        : file.name;
                    const target = prefix ? `${prefix}/${rel}` : rel;
                    if (!validRelPath(target)) {
                      throw new Error(`跳过非法路径 ${rel}`);
                    }
                    status.val = `正在上传 ${done + 1}/${chosen.length}：${target}`;
                    const ok = await writeOne(target, file, {
                      overwriteAsk: chosen.length === 1,
                    });
                    if (ok === false) continue;
                    done++;
                  }
                  status.val = `已上传 ${done} 个文件`;
                  notify("已保存，部署后生效", "success");
                }
                if (!disposed) await refreshFiles();
                uploading = false;
                busy.val = false;
                close();
              } catch (error) {
                status.val = error.message;
                onError(error);
              } finally {
                uploading = false;
                busy.val = false;
              }
            },
          },
          div(
            { class: "actions" },
            button(
              {
                type: "button",
                class: () =>
                  `btn quiet ${mode.val === "files" ? "selected" : ""}`,
                onclick: () => {
                  mode.val = "files";
                },
              },
              "多文件",
            ),
            button(
              {
                type: "button",
                class: () =>
                  `btn quiet ${mode.val === "folder" ? "selected" : ""}`,
                onclick: () => {
                  mode.val = "folder";
                },
              },
              "文件夹",
            ),
            button(
              {
                type: "button",
                class: () =>
                  `btn quiet ${mode.val === "archive" ? "selected" : ""}`,
                onclick: () => {
                  mode.val = "archive";
                  syncArchiveName();
                },
              },
              "压缩包解压",
            ),
          ),
          () =>
            field(
              mode.val === "folder"
                ? "选择文件夹"
                : mode.val === "archive"
                  ? "选择压缩包"
                  : "选择文件（可多选）",
              mode.val === "folder"
                ? folderInput
                : mode.val === "archive"
                  ? archiveInput
                  : filesInput,
            ),
          () =>
            mode.val === "archive"
              ? div(
                  { class: "actions" },
                  button(
                    {
                      type: "button",
                      class: () =>
                        `btn quiet ${unpackMode.val === "folder" ? "selected" : ""}`,
                      onclick: () => {
                        unpackMode.val = "folder";
                        syncArchiveName();
                      },
                    },
                    "创建文件夹",
                  ),
                  button(
                    {
                      type: "button",
                      class: () =>
                        `btn quiet ${unpackMode.val === "spread" ? "selected" : ""}`,
                      onclick: () => {
                        unpackMode.val = "spread";
                        dest.value = "";
                      },
                    },
                    "铺开到当前目录",
                  ),
                )
              : null,
          () =>
            mode.val === "archive"
              ? unpackMode.val === "folder"
                ? field("文件夹名", dest)
                : null
              : field("保存到子目录（可选）", dest),
          p({ class: "form-error", role: "status" }, () => status.val),
          button(
            { type: "submit", class: "btn primary", disabled: () => busy.val },
            () => (busy.val ? "处理中…" : "开始"),
          ),
        );
      },
      { beforeClose: () => !uploading },
    );
  }
  async function renameEntry(path, isDir = false) {
    const next = prompt(isDir ? "新目录路径" : "新文件路径", path);
    if (next == null) return;
    const to = next.trim().replace(/^\/+|\/+$/g, "");
    if (!validRelPath(to)) {
      notify("路径无效", "error");
      return;
    }
    if (docs.has(path) && (docs.get(path).dirty.val || docs.get(path).saving.val)) {
      notify("请先保存或关闭该文件再重命名", "warning");
      return;
    }
    await api.renameFile(site.id, path, to);
    if (docs.has(path)) closeDoc(docs.get(path), true);
    await refreshFiles();
    notify("已重命名", "success");
  }
  async function deleteEntry(path, isDir = false) {
    if (publishKey() && (path === publishKey() || path.startsWith(publishKey() + "/"))) {
      if (
        !confirm(
          isDir
            ? `“${path}”是站点目录。删除后下次部署会空站，确定？`
            : `“${path}”在站点目录里。删除后下次部署会少这个文件，确定？`,
        )
      )
        return;
    } else if (
      !confirm(
        isDir
          ? `删除目录“${path}”及其全部内容？仅删主控，不影响节点，直到下次部署。`
          : `删除文件“${path}”？仅删主控，不影响节点，直到下次部署。`,
      )
    )
      return;
    if (docs.has(path) && (docs.get(path).dirty.val || docs.get(path).saving.val)) {
      notify("请先保存或关闭该文件再删除", "warning");
      return;
    }
    await api.deleteFile(site.id, path);
    if (docs.has(path)) closeDoc(docs.get(path), true);
    // Close any open docs under a deleted directory.
    if (isDir) {
      for (const d of [...docs.values()]) {
        if (d.path === path || d.path.startsWith(path + "/")) closeDoc(d, true);
      }
    }
    await refreshFiles();
    notify("已删除", "success");
  }
  function downloadEntry(path) {
    const a = document.createElement("a");
    a.href = api.downloadURL(site.id, path);
    a.download = path.split("/").at(-1);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function joinPath(dir, name) {
    return dir ? `${dir}/${name}` : name;
  }
  function clearSelection() {
    selected.val = [];
  }
  function toggleSelect(path, on) {
    const set = new Set(selected.val);
    if (on) set.add(path);
    else set.delete(path);
    selected.val = [...set];
  }
  function selectedEntries() {
    const set = new Set(selected.val);
    return files.val.filter((f) => set.has(f.path));
  }
  async function setPublishFromSelection() {
    if (selected.val.length !== 1) {
      notify("请只选一个文件夹设为站点目录", "warning");
      return;
    }
    const path = selected.val[0];
    const listing = listDir(files.val, cwd.val);
    const isFolder =
      listing.folders.some((f) => f.path === path) ||
      files.val.some((f) => f.path === path && f.dir) ||
      files.val.some((f) => f.path.startsWith(path + "/"));
    if (!isFolder) {
      notify("只能把文件夹设为站点目录", "warning");
      return;
    }
    publishPath.val = path;
    await savePublishPath();
    clearSelection();
  }
  async function downloadSelected() {
    for (const path of selected.val) downloadEntry(path);
  }
  async function renameSelected() {
    if (selected.val.length !== 1) {
      notify("重命名请只选一项", "warning");
      return;
    }
    const path = selected.val[0];
    const isDir = !!files.val.find((f) => f.path === path && f.dir);
    await renameEntry(path, isDir);
    clearSelection();
  }
  async function deleteSelected() {
    const list = [...selected.val];
    if (!list.length) return;
    if (!confirm(`删除选中的 ${list.length} 项？仅删主控，直到下次部署。`)) return;
    for (const path of list) {
      const isDir = !!files.val.find((f) => f.path === path && f.dir);
      if (docs.has(path) && (docs.get(path).dirty.val || docs.get(path).saving.val)) {
        notify(`请先保存或关闭 ${path}`, "warning");
        return;
      }
      await api.deleteFile(site.id, path);
      if (docs.has(path)) closeDoc(docs.get(path), true);
      if (isDir) {
        for (const d of [...docs.values()]) {
          if (d.path === path || d.path.startsWith(path + "/")) closeDoc(d, true);
        }
      }
    }
    clearSelection();
    await refreshFiles();
    notify("已删除", "success");
  }
  function enterDir(path) {
    cwd.val = path;
    clearSelection();
    fileFocus.val = "browser";
  }
  function goUp() {
    if (!cwd.val) return;
    const parts = cwd.val.split("/");
    parts.pop();
    enterDir(parts.join("/"));
  }
  function pathCrumbs() {
    const parts = cwd.val ? cwd.val.split("/") : [];
    const crumbs = [{ label: "根目录", path: "" }];
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      crumbs.push({ label: part, path: acc });
    }
    return crumbs;
  }
  function openEntry(entry) {
    if (entry.dir) {
      enterDir(entry.path);
      return;
    }
    openFile(entry).catch(onError);
  }
  function fileManagerRow(entry) {
    const pub = publishKey();
    const isPub = !!(pub && entry.path === pub);
    return div(
      {
        class: () =>
          `file-entry${selected.val.includes(entry.path) ? " selected" : ""}`,
        onclick: (e) => {
          if (e.detail > 1) return;
          toggleSelect(entry.path, !selected.val.includes(entry.path));
        },
        ondblclick: (e) => {
          e.preventDefault();
          openEntry(entry);
        },
      },
      button(
        {
          type: "button",
          class: "file-open",
          title: entry.dir
            ? `${entry.path}/（双击进入）`
            : `${entry.path} · ${formatBytes(entry.size || 0)}（双击打开）`,
          onclick: (e) => {
            e.stopPropagation();
            if (e.detail > 1) return;
            toggleSelect(entry.path, !selected.val.includes(entry.path));
          },
          ondblclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            openEntry(entry);
          },
        },
        icon(
          entry.dir
            ? "folder"
            : modeForPath(entry.path) === "text"
              ? "file"
              : "code",
        ),
        span(
          { class: () => `file-name${isPub ? " publish-dir" : ""}` },
          entry.name,
        ),
        isPub ? span({ class: "file-tag" }, "站点") : null,
        entry.dir
          ? null
          : span({ class: "file-modified" }, () => {
              opened.val;
              return docs.get(entry.path)?.dirty.val ? "●" : "";
            }),
        entry.dir
          ? null
          : small({ class: "file-size" }, formatBytes(entry.size || 0)),
      ),
    );
  }
  const browser = section(
    {
      class: () =>
        `file-browser${fileFocus.val === "editor" ? " mobile-hide" : ""}`,
      "aria-label": "主控文件",
    },
    div(
      { class: "file-pathbar" },
      button(
        {
          type: "button",
          class: "btn icon-only up-btn",
          title: "上级",
          "aria-label": "上级目录",
          disabled: () => !cwd.val,
          onclick: goUp,
        },
        icon("chevron"),
      ),
      div(
        { class: "file-crumbs" },
        () => {
          const crumbs = pathCrumbs();
          return div(
            ...crumbs.map((c, i) =>
              span(
                { class: "file-crumb" },
                button(
                  {
                    type: "button",
                    class: "text-button",
                    disabled: i === crumbs.length - 1,
                    onclick: () => enterDir(c.path),
                  },
                  c.label,
                ),
                i < crumbs.length - 1 ? span({ class: "crumb-sep" }, "/") : null,
              ),
            ),
          );
        },
      ),
    ),
    div({ class: "file-list" }, () => {
      const listing = listDir(files.val, cwd.val);
      const rows = [...listing.folders, ...listing.files];
      if (!rows.length) {
        return div(
          { class: "tree-empty" },
          p(cwd.val ? "此文件夹是空的" : "还没有文件"),
        );
      }
      return div(...rows.map(fileManagerRow));
    }),
    small(
      { class: "file-notice", hidden: () => !fileStatus.val },
      () => fileStatus.val,
    ),
  );

  const editorEmpty = div(
    { class: "editor-empty" },
    button(
      {
        type: "button",
        class: "btn quiet mobile-only",
        onclick: () => {
          fileFocus.val = "browser";
        },
      },
      "← 文件列表",
    ),
    span("选择文件编辑。"),
  );
  const tabs = div(
    { class: "document-tabs", role: "tablist", "aria-label": "打开的文件" },
    () =>
      div(
        { class: "document-tab-items" },
        ...opened.val.map((d) =>
          div(
            {
              class: () =>
                `document-tab ${active.val === d.path ? "selected" : ""}`,
            },
            button(
              {
                type: "button",
                role: "tab",
                "aria-selected": () => active.val === d.path,
                title: d.path,
                onclick: () => activate(d.path),
              },
              icon("code"),
              span(d.path.split("/").at(-1)),
              span({ class: "file-modified" }, () => (d.dirty.val ? "●" : "")),
            ),
            button(
              {
                type: "button",
                class: "tab-close",
                "aria-label": `关闭文件 ${d.path}`,
                onclick: () => closeDoc(d),
              },
              icon("close"),
            ),
          ),
        ),
      ),
  );
  const editorArea = section(
    {
      class: () =>
        `editor-area${fileFocus.val === "browser" && !active.val ? " mobile-hide" : ""}`,
      "aria-label": "代码编辑工作区",
    },
    tabs,
    div(
      { class: "editor-body" },
      hosts,
      div({ class: "empty-overlay", hidden: () => !!active.val }, editorEmpty),
    ),
    div({ class: "editor-footer" }, () => {
      const d = currentDoc();
      return d
        ? div(
            { class: "editor-footer-content" },
            span({ class: "editor-document-path" }, d.path),
            span({ class: "editor-save-status", role: "status" }, () =>
              d.saving.val
                ? "正在保存…"
                : d.dirty.val
                  ? "● 未保存"
                  : d.status.val,
            ),
            small(`${modeForPath(d.path).toUpperCase()} · UTF-8`),
          )
        : span("主控工作区 · 不直接修改线上文件");
    }),
  );
  const fileSplit = div(
    { class: "file-split" },
    browser,
    separator({
      label: "调整文件栏宽度",
      orientation: "vertical",
      read: () => browser.getBoundingClientRect().width,
      write: (n) => fileSplit.style.setProperty("--file-width", `${n}px`),
      min: 170,
      max: () => Math.min(400, fileSplit.clientWidth - 280),
    }),
    editorArea,
  );
  const inspectHost = div({
    class: "code-editor embedded-editor inspect-host",
    "data-inspect-editor": "true",
  });
  let inspectControl = null;
  let inspectLoading = false;
  const inspectStatus = van.state("");
  const inspectKind = van.state("");

  function inspectPath(kind) {
    return (
      {
        caddy: "Caddyfile",
        spec: "site-spec.json",
        snapshot: "deploy-snapshot.json",
        bundle: "bundle-files.txt",
        request: "request.json",
        stages: "stages.txt",
      }[kind] || "inspect.txt"
    );
  }

  function formatInspect(kind, data) {
    if (kind === "spec") return JSON.stringify(data.spec || {}, null, 2);
    if (kind === "snapshot") {
      return data.snapshot
        ? JSON.stringify(data.snapshot, null, 2)
        : "还没有成功部署快照。";
    }
    if (kind === "bundle") {
      const files = data.bundle_files || [];
      const head =
        "publish_path = " +
        (data.publish_label || "(根)") +
        "\n共 " +
        files.length +
        " 个文件会进 bundle.tar\n\n";
      return head + (files.length ? files.join("\n") : "(空)");
    }
    if (kind === "request") return data.request_json || "";
    if (kind === "stages") {
      return (data.stages || [])
        .map((s) => s.title + "\n  " + s.desc)
        .join("\n\n");
    }
    return data.caddy || "";
  }

  async function ensureInspectEditor(kind, text) {
    if (!inspectControl) {
      inspectControl = await createCodeEditor(inspectHost, {
        path: inspectPath(kind),
        value: text,
        readOnly: true,
      });
      return;
    }
    inspectControl.setPath(inspectPath(kind));
    inspectControl.setValue(text);
  }

  async function showInspect(kind) {
    openEpoch++;
    pane.val = kind;
    inspectKind.val = kind;
    if (inspectLoading) return;
    inspectLoading = true;
    inspectStatus.val = "";
    try {
      let text = "";
      if (kind === "caddy") {
        const result = await api.config(site.id);
        if (disposed) return;
        text = result.config || "";
      } else {
        const data = await api.inspect(site.id);
        if (disposed) return;
        text = formatInspect(kind, data);
      }
      await ensureInspectEditor(kind, text);
      if (disposed) {
        inspectControl?.destroy();
        inspectControl = null;
        return;
      }
      inspectControl.focus();
    } catch (error) {
      if (!disposed) {
        inspectStatus.val = error.message;
        onError(error);
      }
    } finally {
      inspectLoading = false;
    }
  }

  // Keep old name used by config sync / openPane.
  async function showConfig({ force = false } = {}) {
    await showInspect("caddy");
  }

  const inspectKinds = [
    ["caddy", "Caddy"],
    ["spec", "规格"],
    ["snapshot", "快照"],
    ["bundle", "打包"],
    ["request", "请求"],
    ["stages", "阶段"],
  ];
  const inspectSelect = select(
    {
      class: "inspect-select",
      onchange: (e) => showInspect(e.target.value),
    },
    ...inspectKinds.map(([value, label]) =>
      option(
        {
          value,
          selected: () => (inspectKind.val || "caddy") === value,
        },
        label,
      ),
    ),
  );
  const inspectPane = div(
    {
      class: "inspect-pane",
      hidden: () =>
        !["caddy", "spec", "snapshot", "bundle", "request", "stages"].includes(
          pane.val,
        ),
    },
    div({ class: "inspect-toolbar" }, inspectSelect),
    inspectHost,
    p(
      {
        class: "form-error",
        role: "status",
        hidden: () => !inspectStatus.val,
      },
      () => inspectStatus.val,
    ),
  );

  async function reloadConfigQuiet() {
    if (pane.val !== "caddy" || inspectLoading) return;
    try {
      await showInspect("caddy");
    } catch (error) {
      if (!disposed) onError(error);
    }
  }
  const ssl = createSSLPane(site, {
    onError,
    notify,
    onUpdated,
    onConfigSynced: reloadConfigQuiet,
  });
  const sslPane = div(
    { class: "ssl-work-pane", hidden: () => pane.val !== "ssl" },
    ssl.element,
    p(
      { class: "pane-hint config-side-hint" },
      "右侧只维护主控配置包。启用 / 停用 / 删除在左边操作远端；只有「部署」会推到节点。",
    ),
  );
  const logsPane = div(
    { class: "logs-work-pane", hidden: () => pane.val !== "logs" },
    div(
      { class: "site-logs-layout" },
      div(
        { class: "task-table-wrap" },
        div(
          { class: "workspace-toolbar logs-mini-toolbar" },
          act("刷新任务", () => onRefreshTasks?.(), "refresh", "quiet"),
        ),
        () => {
          const list = siteTasks();
          return list.length
            ? table(
                thead(tr(th("任务"), th("状态"), th("更新"))),
                tbody(
                  ...list.map((t) =>
                    tr(
                      {
                        class: () =>
                          `task-row${selectedTask?.val === t.id ? " selected" : ""}`,
                        title: "点开任务日志",
                        onclick: () => onChooseTask?.(t.id),
                      },
                      td(
                        span({ class: "task-link" }, taskName(t)),
                        small(t.id.slice(0, 8)),
                      ),
                      td(statusBadge(t.status)),
                      td({ class: "task-time" }, timeLabel(t.updated_at)),
                    ),
                  ),
                ),
              )
            : p({ class: "table-empty" }, "此站点还没有任务。");
        },
      ),
      div(
        { class: "log-pane" },
        div(
          { class: "log-toolbar" },
          span(() =>
            logLoading?.val
              ? "读取中…"
              : selectedTask?.val
                ? taskName(
                    siteTasks().find((t) => t.id === selectedTask.val) || {},
                  )
                : "日志",
          ),
          div(
            { class: "actions" },
            act("刷新日志", () => onLoadLogs?.(), "refresh", "quiet"),
            act(
              "复制日志",
              () => navigator.clipboard.writeText(logText?.val || ""),
              "copy",
              "quiet",
            ),
            act("下载日志", () => downloadLog?.(), "download", "quiet"),
          ),
        ),
        div(
          { class: "log-warning", hidden: () => !logError?.val },
          () => logError?.val || "",
        ),
        pre(
          { class: "log-output", tabindex: 0, "aria-label": "站点执行日志" },
          () => logText?.val || "选择任务查看日志。",
        ),
      ),
    ),
  );
  function openLogs() {
    pane.val = "logs";
    const list = siteTasks();
    if (list[0] && selectedTask && !list.some((t) => t.id === selectedTask.val))
      onChooseTask?.(list[0].id);
    else onLoadLogs?.();
  }
  const element = div(
    { class: "site-workspace", "data-site-id": site.id },
    div(
      { class: "workspace-tabs", role: "tablist", "aria-label": "站点功能" },
      button(
        {
          type: "button",
          role: "tab",
          class: () => (pane.val === "ssl" ? "selected" : ""),
          "aria-selected": () => pane.val === "ssl",
          onclick: () => {
            pane.val = "ssl";
          },
        },
        icon("config"),
        "配置",
      ),
      button(
        {
          type: "button",
          role: "tab",
          class: () => (pane.val === "files" ? "selected" : ""),
          "aria-selected": () => pane.val === "files",
          onclick: () => {
            pane.val = "files";
            currentDoc()?.control?.focus();
          },
        },
        icon("folder"),
        "文件",
      ),
      button(
        {
          type: "button",
          role: "tab",
          class: () =>
            `tab-muted${["caddy", "spec", "snapshot", "bundle", "request", "stages"].includes(pane.val) ? " selected" : ""}`,
          "aria-selected": () =>
            ["caddy", "spec", "snapshot", "bundle", "request", "stages"].includes(pane.val),
          title: "只读排查：Caddy / 规格 / 快照等",
          onclick: () => showInspect(inspectKind.val || "caddy"),
        },
        "排查",
      ),
      div(
        { class: "tab-actions" },
        button(
          {
            type: "button",
            class: "btn primary deploy-tab",
            onclick: () => onDeploy?.(),
          },
          icon("send"),
          span("部署"),
        ),
        button(
          {
            type: "button",
            role: "tab",
            class: () => (pane.val === "logs" ? "selected" : ""),
            "aria-selected": () => pane.val === "logs",
            onclick: openLogs,
          },
          icon("logs"),
          "站日志",
        ),
      ),
    ),
    sslPane,
    inspectPane,
    div(
      { class: "files-pane", hidden: () => pane.val !== "files" },
      div(
        { class: "workspace-toolbar file-toolbar" },
        div(
          { class: "actions" },
          act("新建", newFile, "plus", "quiet"),
          act("目录", newFolder, "folder", "quiet"),
          act("上传", upload, "upload", "quiet"),
          act("刷新", () => refreshFiles().then(clearSelection), "refresh", "quiet"),
        ),
        () =>
          selected.val.length
            ? div(
                { class: "actions selection-actions" },
                span({ class: "pane-hint" }, `已选 ${selected.val.length}`),
                act("设为站点目录", () => setPublishFromSelection(), "check", "quiet"),
                act("下载", () => downloadSelected(), "download", "quiet"),
                act("重命名", () => renameSelected(), "pencil", "quiet"),
                act("删除", () => deleteSelected(), "failed", "quiet"),
                act("取消", clearSelection, "close", "quiet"),
              )
            : div(
                { class: "actions" },
                span(
                  { class: "pane-hint" },
                  () =>
                    publishKey()
                      ? `站点：${publishKey()}/`
                      : "站点：根目录",
                ),
                act(
                  "保存",
                  () => saveDoc(currentDoc()),
                  "save",
                  "",
                  () => !currentDoc()?.ready.val || currentDoc()?.saving.val,
                ),
              ),
      ),
      fileSplit,
    ),
    logsPane,
  );
  // The controller owns only its editor DOM. Task polling must never replace it.
  refreshFiles().catch(onError);
  return {
    element,
    hasDirty,
    hasSaving,
    updateSSL: ssl.update,
    focusName: () => ssl.focusName?.(),
    openPane(name) {
      if (name === "nginx" || name === "caddy" || name === "config") showInspect("caddy");
      else if (name === "spec") showInspect("spec");
      else if (name === "snapshot") showInspect("snapshot");
      else if (name === "bundle" || name === "request" || name === "stages")
        showInspect(name);
      else if (name === "logs") openLogs();
      else if (
        name === "domains" ||
        name === "https" ||
        name === "ssl" ||
        name === "vars" ||
        name === "settings"
      )
        pane.val = "ssl";
      else pane.val = name;
    },
    updateVars: ssl.updateVars,

    canLeave() {
      if (hasSaving()) {
        notify("正在保存，请稍候再切换", "warning");
        return false;
      }
      return (
        !hasDirty() ||
        confirm("当前站点有未保存的文件或 Caddy 配置，确定放弃修改并切换吗？")
      );
    },
    dispose() {
      disposed = true;
      fileEpoch++;
      for (const d of docs.values()) {
        d.closed = true;
        d.control?.destroy();
      }
      docs.clear();
      inspectControl?.destroy();
      inspectControl = null;
      window.removeEventListener("beforeunload", beforeUnload);
    },
  };
}
