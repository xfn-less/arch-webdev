import van from "../vendor/van-1.6.1.js";
import { api } from "./api.js";
import { createCodeEditor, modeForPath } from "./editor.js";
import { action, field, icon, modal, separator } from "./ui.js";
import { fileTree, formatBytes } from "./files.js";
import { createSSLPane } from "./ssl.js";
import { createVarsPane } from "./vars.js";
const {
  button,
  details,
  div,
  form,
  input,
  p,
  pre,
  section,
  small,
  span,
  summary,
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
    onSSLTask,
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
    pane = van.state("nginx"),
    opened = van.state([]),
    active = van.state(""),
    fileStatus = van.state("正在读取主控文件…");
  const configStatus = van.state("");
  const configSource = van.state("generated");
  const configDirty = van.state(false);
  const configSaving = van.state(false);
  const docs = new Map(),
    expanded = new Map(),
    fileCollapsed = new Map();
  let disposed = false,
    configControl,
    configLoading = false,
    configSaved = "",
    fileEpoch = 0,
    openEpoch = 0;
  const act = (text, fn, glyph, kind = "", disabled) =>
    action(text, fn, { glyph, kind, onError, disabled });
  const hosts = div({ class: "editor-hosts" });
  const currentDoc = () => docs.get(active.val);
  const hasDirty = () =>
    configDirty.val || [...docs.values()].some((d) => d.dirty.val);
  const hasSaving = () =>
    configSaving.val || [...docs.values()].some((d) => d.saving.val);
  const updateDirty = (d) => {
    if (d.control)
      d.dirty.val = !d.existing || d.control.getValue() !== d.saved;
  };
  const updateConfigDirty = () => {
    configDirty.val = !!configControl && configControl.getValue() !== configSaved;
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
      files.val = list;
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
    if (active.val === d.path) activate(opened.val.at(-1)?.path || "");
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
      const path = input({
        required: true,
        value: files.val.some((f) => f.path === "index.html")
          ? "untitled.html"
          : "index.html",
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
  function upload() {
    let uploading = false;
    modal(
      "上传到主控",
      (close) => {
        const mode = van.state("files");
        const filesInput = input({ type: "file", multiple: true });
        const folderInput = input({ type: "file", webkitdirectory: true, directory: true });
        const zipInput = input({ type: "file", accept: ".zip,application/zip" });
        const dest = input({ placeholder: "可选子目录，例如 assets" });
        const busy = van.state(false),
          status = van.state("");
        const pick = () =>
          mode.val === "folder"
            ? folderInput
            : mode.val === "zip"
              ? zipInput
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
              const prefix = dest.value.trim().replace(/^\/+|\/+$/g, "");
              if (prefix && !validRelPath(prefix)) {
                status.val = "目标目录路径无效";
                return;
              }
              uploading = true;
              busy.val = true;
              try {
                if (mode.val === "zip") {
                  status.val = "正在解压到主控…";
                  await api.unzip(site.id, chosen[0], prefix);
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
                }
                if (!disposed) await refreshFiles();
                uploading = false;
                busy.val = false;
                close();
                notify("已保存，部署后生效", "success");
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
                class: () => `btn quiet ${mode.val === "files" ? "selected" : ""}`,
                onclick: () => {
                  mode.val = "files";
                },
              },
              "多文件",
            ),
            button(
              {
                type: "button",
                class: () => `btn quiet ${mode.val === "folder" ? "selected" : ""}`,
                onclick: () => {
                  mode.val = "folder";
                },
              },
              "文件夹",
            ),
            button(
              {
                type: "button",
                class: () => `btn quiet ${mode.val === "zip" ? "selected" : ""}`,
                onclick: () => {
                  mode.val = "zip";
                },
              },
              "ZIP 解压",
            ),
          ),
          () =>
            field(
              mode.val === "folder"
                ? "选择文件夹"
                : mode.val === "zip"
                  ? "选择 ZIP"
                  : "选择文件（可多选）",
              mode.val === "folder"
                ? folderInput
                : mode.val === "zip"
                  ? zipInput
                  : filesInput,
            ),
          field("保存到子目录（可选）", dest),
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
    if (
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
  function entryActions(path, isDir = false) {
    return div(
      {
        class: "file-entry-actions",
        onclick: (event) => event.stopPropagation(),
      },
      button({
        type: "button",
        class: "icon-only",
        title: isDir ? "打包下载" : "下载",
        "aria-label": `${isDir ? "打包下载" : "下载"} ${path}`,
        onclick: () => downloadEntry(path),
      }, icon("download")),
      button({
        type: "button",
        class: "icon-only",
        title: "重命名",
        "aria-label": `重命名 ${path}`,
        onclick: () => renameEntry(path, isDir).catch(onError),
      }, icon("pencil")),
      button({
        type: "button",
        class: "icon-only",
        title: "删除",
        "aria-label": `删除 ${path}`,
        onclick: () => deleteEntry(path, isDir).catch(onError),
      }, icon("failed")),
    );
  }
  function fileRow(file) {
    return div(
      {
        class: () =>
          `file-entry ${active.val === file.path ? "selected" : ""}`,
      },
      button(
        {
          type: "button",
          class: "file-open",
          "aria-label": `打开文件 ${file.path}`,
          title: `${file.path} · ${formatBytes(file.size)}`,
          onclick: () => openFile(file).catch(onError),
        },
        icon(modeForPath(file.path) === "text" ? "file" : "code"),
        span({
          class: "file-name",
          title: `${file.name}（双击展开/收起全名）`,
          ondblclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.classList.toggle("expanded");
          },
        }, file.name),
        span({ class: "file-modified" }, () => {
          opened.val;
          return docs.get(file.path)?.dirty.val ? "●" : "";
        }),
      ),
      entryActions(file.path, false),
    );
  }
  function treeBranch(branch, folderPath = "") {
    const FILE_COLLAPSE = 8;
    const collapsed =
      fileCollapsed.get(folderPath) !== false &&
      branch.files.length > FILE_COLLAPSE;
    const shown = collapsed ? branch.files.slice(0, FILE_COLLAPSE) : branch.files;
    return div(
      { class: "tree-branch" },
      ...branch.folders.map((folder) =>
        details(
          {
            open: expanded.get(folder.path) !== false,
            ontoggle: (event) =>
              expanded.set(folder.path, event.currentTarget.open),
          },
          summary(
            icon("chevron"),
            icon("folder"),
            span({
              class: "file-name",
              title: `${folder.name}（双击展开/收起全名）`,
              ondblclick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.currentTarget.classList.toggle("expanded");
              },
            }, folder.name),
            entryActions(folder.path, true),
          ),
          treeBranch(folder, folder.path),
        ),
      ),
      ...shown.map(fileRow),
      ...(branch.files.length > FILE_COLLAPSE
        ? [
            button(
              {
                type: "button",
                class: "file-more text-button",
                onclick: () => {
                  fileCollapsed.set(folderPath, collapsed);
                  files.val = [...files.val];
                },
              },
              collapsed
                ? `显示其余 ${branch.files.length - FILE_COLLAPSE} 个文件`
                : "收起文件列表",
            ),
          ]
        : []),
    );
  }
  const browser = section(
    { class: "file-browser", "aria-label": "主控文件" },
    div(
      { class: "file-browser-head" },
      span(icon("folder"), "主控文件"),
      small(() => String(files.val.filter((f) => !f.dir).length)),
    ),
    div({ class: "file-tree" }, () =>
      files.val.length
        ? treeBranch(fileTree(files.val))
        : div(
            { class: "tree-empty" },
            icon("folder"),
            p("还没有文件"),
            small("上传页面或新建 index.html"),
          ),
    ),
    small(
      { class: "file-notice", hidden: () => !fileStatus.val },
      () => fileStatus.val,
    ),
  );
  const editorEmpty = div({ class: "editor-empty" }, "选择文件编辑。");
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
    { class: "editor-area", "aria-label": "代码编辑工作区" },
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
  const configHost = div({
    class: "code-editor embedded-editor",
    "data-config-editor": "true",
  });
  function applyConfig(result) {
    configSaved = result.config;
    configSource.val = result.source || "generated";
    if (configControl) configControl.setValue(result.config);
    updateConfigDirty();
    configStatus.val =
      configSource.val === "custom"
        ? "已保存，部署后生效。证书/ACME 在 panel.inc；此处只改业务 conf。"
        : "当前为默认生成配置；保存后将成为该站自定义配置。";
  }
  async function showConfig({ force = false } = {}) {
    openEpoch++;
    pane.val = "nginx";
    if (configLoading) return;
    if (configControl && !force) {
      configControl.focus();
      return;
    }
    if (configDirty.val && !force && !confirm("Nginx 配置有未保存修改，确定重新读取吗？"))
      return;
    configLoading = true;
    configStatus.val = "正在读取主控 Nginx 配置…";
    try {
      const result = await api.config(site.id);
      if (disposed) return;
      if (!configControl)
        configControl = await createCodeEditor(configHost, {
          path: "nginx.conf",
          value: result.config,
          onSave: () => saveConfig(),
          onChange: updateConfigDirty,
        });
      if (disposed) {
        configControl.destroy();
        return;
      }
      applyConfig(result);
      configControl.focus();
    } catch (error) {
      if (!disposed) {
        configStatus.val = error.message;
        onError(error);
      }
    } finally {
      configLoading = false;
    }
  }
  async function saveConfig() {
    if (!configControl || configSaving.val) return;
    const text = configControl.getValue();
    configSaving.val = true;
    configStatus.val = "正在保存…";
    try {
      const result = await api.saveConfig(site.id, text);
      if (disposed) return;
      applyConfig(result);
      notify("已保存，部署后生效", "success");
    } catch (error) {
      if (!disposed) {
        configStatus.val = error.message;
        onError(error);
      }
    } finally {
      configSaving.val = false;
    }
  }
  async function resetConfig() {
    if (configSaving.val) return;
    if (
      !confirm(
        "恢复为根据域名/端口/证书生成的默认配置？自定义原文会从主控删除。",
      )
    )
      return;
    configSaving.val = true;
    configStatus.val = "正在恢复默认生成配置…";
    try {
      const result = await api.resetConfig(site.id);
      if (disposed) return;
      applyConfig(result);
      notify("已恢复默认生成配置", "success");
    } catch (error) {
      if (!disposed) {
        configStatus.val = error.message;
        onError(error);
      }
    } finally {
      configSaving.val = false;
    }
  }
  const configPane = div(
    { class: "config-pane", hidden: () => pane.val !== "nginx" },
    div(
      { class: "workspace-toolbar" },
      div(
        { class: "actions" },
        span(
          { class: "inline-note" },
          icon("code"),
          span(() =>
            configSource.val === "custom" ? "自定义配置" : "默认生成配置",
          ),
        ),
        act("重新读取", () => showConfig({ force: true }), "refresh", "quiet"),
        act(
          "恢复默认生成",
          resetConfig,
          "refresh",
          "quiet",
          () => configSaving.val || configSource.val !== "custom",
        ),
      ),
      act(
        "保存配置",
        saveConfig,
        "save",
        "",
        () => configSaving.val || !configDirty.val,
      ),
    ),
    configHost,
    p(
      { class: "pane-hint", role: "status", hidden: () => !configStatus.val },
      () => configStatus.val,
    ),
  );
  const ssl = createSSLPane(site, {
    onError,
    notify,
    onTask: onSSLTask,
    onUpdated,
  });
  const sslPane = div(
    { class: "ssl-work-pane", hidden: () => pane.val !== "ssl" },
    ssl.element,
  );
  const varsPaneCtl = createVarsPane(site, { onError, notify, onUpdated });
  const varsPane = div(
    { class: "vars-work-pane", hidden: () => pane.val !== "vars" },
    varsPaneCtl.element,
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
                          selectedTask?.val === t.id ? "selected" : "",
                      },
                      td(
                        button(
                          {
                            type: "button",
                            class: "task-link text-button",
                            onclick: () => onChooseTask?.(t.id),
                          },
                          taskName(t),
                        ),
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
          class: () => (pane.val === "nginx" ? "selected" : ""),
          "aria-selected": () => pane.val === "nginx",
          onclick: () => showConfig(),
        },
        icon("code"),
        "Nginx",
      ),
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
        icon("lock"),
        "域名&SSL",
      ),
      button(
        {
          type: "button",
          role: "tab",
          class: () => (pane.val === "vars" ? "selected" : ""),
          "aria-selected": () => pane.val === "vars",
          onclick: () => {
            pane.val = "vars";
          },
        },
        icon("config"),
        "链接变量",
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
    configPane,
    sslPane,
    varsPane,
    div(
      { class: "files-pane", hidden: () => pane.val !== "files" },
      div(
        { class: "workspace-toolbar" },
        div(
          { class: "actions" },
          act("新建文本", newFile, "plus"),
          act("新建目录", newFolder, "folder", "quiet"),
          act("上传", upload, "upload"),
          act("刷新文件", refreshFiles, "refresh", "quiet"),
        ),
        act(
          "保存",
          () => saveDoc(currentDoc()),
          "save",
          "",
          () => !currentDoc()?.ready.val || currentDoc()?.saving.val,
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
    openPane(name) {
      if (name === "nginx") showConfig();
      else if (name === "logs") openLogs();
      else pane.val = name;
    },
    updateVars: varsPaneCtl.update,

    canLeave() {
      if (hasSaving()) {
        notify("正在保存，请稍候再切换", "warning");
        return false;
      }
      return (
        !hasDirty() ||
        confirm("当前站点有未保存的文件或 Nginx 配置，确定放弃修改并切换吗？")
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
      configControl?.destroy();
      window.removeEventListener("beforeunload", beforeUnload);
    },
  };
}
