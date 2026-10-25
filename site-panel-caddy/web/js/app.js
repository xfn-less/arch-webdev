import van from "../vendor/van-1.6.1.js";
import { api, setCSRF } from "./api.js";
import { action, field, icon, modal } from "./ui.js";
import { createWorkspace } from "./workspace.js";
import { createNodeWorkspace, createDraftNodeWorkspace, createTelegramWorkspace, agentOutdated } from "./node.js";
import { taskLabels, stepLabels } from "./files.js";
import { sslLabel, domainLabel, siteHref } from "./ssl.js";
const {
  a,
  aside,
  button,
  div,
  form,
  h1,
  header,
  input,
  label,
  main,
  option,
  p,
  pre,
  section,
  select,
  small,
  span,
  table,
  textarea,
  tbody,
  td,
  th,
  thead,
  tr,
} = van.tags;
const authenticated = van.state(false),
  initialized = van.state(true),
  expired = van.state(false);
const nodes = van.state([]),
  sites = van.state([]),
  tasks = van.state([]),
  route = van.state({ kind: "node" });
const notice = van.state(null),
  view = van.state("workspace"),
  selectedTask = van.state("");
const mobilePane = van.state("list");
const nodeStatuses = van.state({});
const nodeChecking = van.state({});
const logText = van.state("选择任务查看日志。"),
  logError = van.state(""),
  logLoading = van.state(false),
  logTime = van.state("");
let workMount,
  workspace,
  loaded = false,
  initialShown = false,
  polling = false,
  reauthDialog,
  logAbort,
  logEpoch = 0,
  lastLogSignature = "",
  logScroll;
let taskNode = "",
  taskEpoch = 0;
const actionIcons = {
  添加节点: "plus",
  添加站点: "plus",
  刷新: "refresh",
  "更新": "terminal",
  检查: "diagnose",
  检查全部: "diagnose",
  退出: "logout",
  编辑: "config",
  重命名: "pencil",
  复制到节点: "copy",
  停用: "ban",
  启用: "check",
  删除: "failed",
  "安装 agent": "terminal",
  "添加 IP 节点": "plus",
  "添加 IP": "plus",
  "TG 推送": "send",
  停用站点: "warning",
  启用站点: "check",
  删除站点: "failed",
  caddy配置: "config",
  nginx配置: "config",
  打开文件夹: "folder-open",
  部署: "send",
  日志: "logs",
  节点任务: "logs",
  刷新任务: "refresh",
  刷新日志: "refresh",
  复制日志: "copy",
  下载日志: "download",
  返回工作区: "folder-open",
  关闭提示: "close",
};
const act = (text, fn, kind = "", disabled) =>
  action(text, fn, {
    kind,
    disabled,
    glyph: actionIcons[text] || (text.startsWith("SSL") ? "lock" : undefined),
    onError: showError,
  });
function notify(text, tone = "info") {
  notice.val = { text, tone };
  if (tone !== "error" && !expired.val) {
    const stamp = text;
    setTimeout(() => {
      if (notice.val?.text === stamp) notice.val = null;
    }, 4200);
  }
}
function showError(error) {
  notify(error.message || "操作失败", "error");
  if (error.status === 401 && authenticated.val) {
    expired.val = true;
    reauthenticate();
  }
}
function currentNodeId() {
  if (route.val.kind === "site")
    return sites.val.find((s) => s.id === route.val.id)?.node_id;
  if (route.val.kind === "node") return route.val.id || nodes.val[0]?.id;
  return nodes.val[0]?.id;
}
function currentNode() {
  return nodes.val.find((n) => n.id === currentNodeId());
}
function nodeForSite(s) {
  return nodes.val.find((n) => n.id === s.node_id);
}
function taskName(t) {
  const s = sites.val.find((s) => s.id === t.site_id);
  return t.site_id
    ? `${s?.name || "站点"}${t.kind === "ssl" ? " / HTTPS" : ""}`
    : `${nodes.val.find((n) => n.id === t.node_id)?.host || "节点"} / 安装`;
}
function timeLabel(date) {
  return date ? new Date(date).toLocaleString() : "—";
}
function remember(r) {
  try {
    localStorage.setItem("site-panel-route", JSON.stringify(r));
  } catch {}
}
function lastRoute() {
  try {
    return JSON.parse(localStorage.getItem("site-panel-route"));
  } catch {
    return null;
  }
}
function navigate(next, { force = false } = {}) {
  if (!workMount?.isConnected) return false;
  if (!force && workspace && !workspace.canLeave()) return false;
  workspace?.dispose();
  workspace = undefined;
  workMount.replaceChildren();
  if (next?.kind === "draft-node" || next?.kind === "telegram")
    route.val = { kind: next.kind };
  else if (next?.kind === "site" && sites.val.some((s) => s.id === next.id))
    route.val = next;
  else
    route.val = {
      kind: "node",
      id: nodes.val.some((n) => n.id === next?.id) ? next.id : nodes.val[0]?.id,
    };
  remember(route.val);
  view.val = "workspace";
  mobilePane.val = "work";
  const changed = resetTaskNode(currentNodeId());
  if (changed) refreshTasks().catch(showError);
  if (route.val.kind === "draft-node") {
    workspace = createDraftNodeWorkspace({
      notify,
      onError: showError,
      onCreated: async (n) => {
        await load();
        navigate({ kind: "node", id: n.id }, { force: true });
      },
    });
    workMount.append(workspace.element);
  } else if (route.val.kind === "telegram") {
    workspace = createTelegramWorkspace({ notify, onError: showError });
    workMount.append(workspace.element);
  } else if (route.val.kind === "site") {
    const s = sites.val.find((s) => s.id === route.val.id);
    workspace = createWorkspace(s, {
      notify,
      onError: showError,
      onUpdated: load,
      onDeploy: () => {
        const fresh = sites.val.find((x) => x.id === s.id) || s;
        return deploySite(fresh);
      },
      siteTasks: () => tasks.val.filter((t) => t.site_id === s.id),
      selectedTask,
      logText,
      logError,
      logLoading,
      logTime,
      onChooseTask: chooseTask,
      onLoadLogs: loadLogs,
      onRefreshTasks: poll,
      taskName,
      timeLabel,
      statusBadge,
      downloadLog,
    });
    workMount.append(workspace.element);
  } else if (route.val.kind === "node" && route.val.id) {
    const n = nodes.val.find((x) => x.id === route.val.id);
    if (!n) {
      workMount.append(p({ class: "work-placeholder" }, "节点不存在。"));
      return true;
    }
    workspace = createNodeWorkspace(n, {
      notify,
      onError: showError,
      onInstall: () => installNode().catch(showError),
      onDelete: () => removeNode(n).catch(showError),
      onUpdated: load,
      onStatus: rememberNodeStatus,
      onOpenSite: (s) => openPane(s, "ssl"),
      onChooseTask: (t) => openNodeTaskLog(t.id),
      nodeSites: () => sitesForNode(n.id),
      nodeTasks: () => tasks.val.filter((t) => t.node_id === n.id),
      selectedTask,
      timeLabel,
      statusBadge,
    });
    workMount.append(workspace.element);
    if (nodeStatuses.val[n.id]) workspace.applyStatus?.(nodeStatuses.val[n.id]);
  } else
    workMount.append(
      p(
        { class: "work-placeholder" },
        nodes.val.length ? "点左边节点或站点进入右侧。" : "先添加节点。",
      ),
    );
  return true;
}
function openPane(s, name) {
  if (route.val.kind !== "site" || route.val.id !== s.id) {
    if (!navigate({ kind: "site", id: s.id })) return;
  }
  view.val = "workspace";
  workspace?.openPane?.(name);
  if (name === "logs") {
    const task = tasks.val.find((t) => t.site_id === s.id);
    if (task) chooseTask(task.id);
    else loadLogs();
  }
}
function showInitial() {
  if (!initialShown && loaded && workMount?.isConnected) {
    initialShown = true;
    navigate(lastRoute() || { kind: "node" }, { force: true });
  }
}
async function load() {
  const [n, s, st] = await Promise.all([
    api.nodes(),
    api.sites(),
    api.nodeStatuses().catch(() => ({})),
  ]);
  nodes.val = n;
  sites.val = s;
  nodeStatuses.val = st || {};
  loaded = true;
  showInitial();
  await refreshTasks();
  if (route.val.kind === "site")
    workspace?.updateSSL(s.find((x) => x.id === route.val.id)?.ssl);
}

function rememberNodeStatus(id, st) {
  nodeStatuses.val = { ...nodeStatuses.val, [id]: st || {} };
}

function setNodeChecking(id, on) {
  nodeChecking.val = { ...nodeChecking.val, [id]: !!on };
}

function nodeStatusTone(id) {
  if (nodeChecking.val[id]) return "checking";
  const st = nodeStatuses.val[id];
  if (!st || (!st.observed_at && !st.error && !st.version && !st.caddy && !st.nginx))
    return "unknown";
  if (st.error) return "bad";
  const caddy = st.caddy || st.nginx || "";
  if (caddy && caddy !== "active") return "bad";
  if (st.version && agentOutdated(st.version)) return "warn";
  return "ok";
}

function nodeCheckIcon(id) {
  const tone = nodeStatusTone(id);
  if (tone === "checking") return icon("refresh");
  if (tone === "ok") return icon("success");
  if (tone === "bad") return icon("failed");
  if (tone === "warn") return icon("warning");
  return icon("diagnose");
}

function nodeCheckTitle(id) {
  const tone = nodeStatusTone(id);
  const st = nodeStatuses.val[id];
  if (tone === "checking") return "检查中…";
  if (!st) return "检查节点";
  const when = st.observed_at ? timeLabel(st.observed_at) : "";
  if (st.error) return `上次失败：${st.error}${when ? " · " + when : ""}`;
  const caddy = st.caddy || st.nginx || "?";
  return `上次：Caddy ${caddy} / agent ${st.version || "?"}${when ? " · " + when : ""}`;
}

async function checkNode(id, { quiet = false } = {}) {
  const n = nodes.val.find((x) => x.id === id);
  if (!n) return null;
  if (nodeChecking.val[id]) return null;
  setNodeChecking(id, true);
  try {
    const st = await api.status(id);
    rememberNodeStatus(id, st);
    if (
      route.val.kind === "node" &&
      route.val.id === id &&
      workspace?.applyStatus
    ) {
      workspace.applyStatus(st);
    }
    if (!quiet) {
      notify(
        `${n.host}：Caddy ${st.caddy || st.nginx || "?"}，agent ${st.version || "?"}`,
        "success",
      );
    }
    return { ok: true, host: n.host, st };
  } catch (e) {
    const st = {
      error: e.message || "检查失败",
      observed_at: new Date().toISOString(),
    };
    rememberNodeStatus(id, st);
    if (
      route.val.kind === "node" &&
      route.val.id === id &&
      workspace?.applyStatus
    ) {
      workspace.applyStatus(st);
    }
    if (!quiet) notify(`${n.host}：检查失败 — ${st.error}`, "error");
    return { ok: false, host: n.host, error: st.error };
  } finally {
    setNodeChecking(id, false);
  }
}

async function checkAllNodes() {
  const list = nodes.val;
  if (!list.length) {
    notify("没有节点");
    return;
  }
  notify(`正在检查 ${list.length} 台…`);
  const results = await Promise.all(
    list.map((n) => checkNode(n.id, { quiet: true })),
  );
  const done = results.filter(Boolean);
  const ok = done.filter((r) => r.ok);
  const bad = done.filter((r) => !r.ok);
  if (!bad.length) {
    notify(`检查全部完成：${ok.length}/${list.length} 正常`, "success");
    return;
  }
  notify(
    `检查全部完成：${ok.length} 正常，${bad.length} 异常 — ${bad
      .map((b) => b.host)
      .join(", ")}`,
    bad.length === list.length ? "error" : "warning",
  );
}
function authView() {
  const password = input({
      type: "password",
      required: true,
      minlength: 12,
      maxlength: 72,
      autocomplete: initialized.val ? "current-password" : "new-password",
    }),
    busy = van.state(false),
    error = van.state("");
  return main(
    { class: "auth-screen" },
    section(
      { class: "auth-card" },
      h1("站点管理"),
      form(
        {
          onsubmit: async (event) => {
            event.preventDefault();
            if (busy.val) return;
            busy.val = true;
            try {
              const result = await api.login(password.value, !initialized.val);
              setCSRF(result.csrf);
              initialized.val = true;
              authenticated.val = true;
              notice.val = null;
              await load();
            } catch (e) {
              error.val = e.message;
            } finally {
              busy.val = false;
            }
          },
        },
        field("面板密码", password, "至少 12 字节。"),
        p({ class: "form-error", role: "alert" }, () => error.val),
        button(
          { class: "btn", type: "submit", disabled: () => busy.val },
          () =>
            busy.val
              ? "连接中…"
              : initialized.val
                ? "登录工作台"
                : "创建面板密码",
        ),
      ),
    ),
  );
}
function reauthenticate() {
  if (reauthDialog) return;
  reauthDialog = modal(
    "登录已过期，重新登录后继续编辑",
    (close) => {
      const password = input({
          type: "password",
          required: true,
          autocomplete: "current-password",
        }),
        error = van.state(""),
        busy = van.state(false);
      return form(
        {
          onsubmit: async (event) => {
            event.preventDefault();
            busy.val = true;
            try {
              const result = await api.login(password.value, false);
              setCSRF(result.csrf);
              expired.val = false;
              close();
              notify("已重新登录，草稿保留，请再次保存。");
            } catch (e) {
              error.val = e.message;
            } finally {
              busy.val = false;
            }
          },
        },
        field("面板密码", password),
        p({ class: "form-error", role: "alert" }, () => error.val),
        button(
          { type: "submit", class: "btn", disabled: () => busy.val },
          "重新登录",
        ),
      );
    },
    {
      onClose: () => {
        reauthDialog = undefined;
      },
    },
  );
}
async function logout() {
  if (workspace && !workspace.canLeave()) return;
  try {
    await api.logout();
  } catch (e) {
    if (e.status !== 401) throw e;
  }
  workspace?.dispose();
  workspace = undefined;
  logAbort?.abort();
  reauthDialog?.close();
  authenticated.val = false;
  expired.val = false;
  setCSRF("");
  loaded = false;
  initialShown = false;
  nodes.val = [];
  sites.val = [];
  resetTaskNode("");
  notice.val = null;
}
function startAddNode() {
  navigate({ kind: "draft-node" }, { force: true });
}
function startTelegram() {
  navigate({ kind: "telegram" }, { force: true });
}
async function quickAddSite(preferredNodeId = "") {
  const node =
    nodes.val.find((n) => n.id === preferredNodeId) ||
    currentNode() ||
    nodes.val[0];
  if (!node) {
    startAddNode();
    return;
  }
  const stamp = String(Date.now()).slice(-4);
  const used = new Set(
    sitesForNode(node.id).flatMap((s) => (s.domains || []).map((d) => d.toLowerCase())),
  );
  // Always use node real IP with explicit port (same as typing ip:10000).
  let domain = "";
  for (let p = 10000; p < 10100; p++) {
    const cand = `${node.host}:${p}`;
    if (!used.has(cand.toLowerCase())) {
      domain = cand;
      break;
    }
  }
  if (!domain) throw new Error("该节点 10000–10099 端口已被占满");
  const s = await api.addSite({
    name: `新站点${stamp}`,
    node_id: node.id,
    domains: [domain],
    cert: "off",
    redir_https: false,
    mode: "static",
  });
  await load();
  navigate({ kind: "site", id: s.id }, { force: true });
  workspace?.openPane?.("ssl");
  workspace?.focusName?.();
  notify("已在当前 IP 创建站点，可在配置里改站名和域名", "success");
}
async function queryNode() {
  const n = currentNode();
  if (!n) return;
  await checkNode(n.id);
}
async function removeNode(n) {
  const bound = sites.val.filter((s) => s.node_id === n.id);
  const extra = bound.length
    ? `
该节点下有 ${bound.length} 个站点，删除后会解绑并保留站点原件。`
    : "";
  if (
    !confirm(
      `删除节点 ${n.host}？仅删主控记录，不管远端机器。${extra}`,
    )
  )
    return;
  const wasHere =
    (route.val.kind === "node" && route.val.id === n.id) ||
    (route.val.kind === "site" &&
      sites.val.find((x) => x.id === route.val.id)?.node_id === n.id);
  await api.deleteNode(n.id);
  await load();
  if (wasHere) {
    const next = nodes.val[0];
    if (next) navigate({ kind: "node", id: next.id }, { force: true });
    else navigate({ kind: "draft-node" }, { force: true });
  }
  notify(`${n.host}：节点已删除`, "success");
}
async function installNode(nodeId = "") {
  const id = nodeId || currentNodeId();
  const n = nodes.val.find((x) => x.id === id);
  if (!n) {
    notify("先选择节点");
    return;
  }
  if (route.val.kind !== "node" || route.val.id !== n.id) {
    if (!navigate({ kind: "node", id: n.id })) return;
  }
  if (
    !confirm(
      `在 ${n.host} 安装/更新执行器与 Caddy？已有 Nginx 的机器请换干净节点。`,
    )
  )
    return;
  const result = await api.install(n.id);
  await selectNewTask(result.task_id, n.id);
  // 安装失败原因以前容易看不到：等任务结束并 toast 出来
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    await refreshTasks();
    const task = tasks.val.find((x) => x.id === result.task_id);
    if (!task) continue;
    if (task.status === "succeeded") {
      notify(`${n.host}：agent 安装成功`, "success");
      return;
    }
    if (task.status === "failed") {
      notify(`${n.host}：安装失败 — ${task.error || task.step}`, "error");
      return;
    }
  }
  notify(`${n.host}：安装仍在进行，节点页下方可看日志`, "warn");
}
async function submitDeploy(s, force = false) {
  try {
    const result = await api.deploy(s.id, { force });
    await selectNewTask(result.task_id, s.node_id);
    notify(`${s.name}：部署已提交。`);
    return true;
  } catch (e) {
    if (e.status === 409) {
      if (
        confirm(
          `${e.message}

仍要强制部署吗？强制后若是 80/443 不通，HTTPS 仍可能签失败。`,
        )
      ) {
        return submitDeploy(s, true);
      }
      return false;
    }
    throw e;
  }
}
async function deploySite(s) {
  if (s.enabled === false) {
    notify("站点已停用，请先在站点设置里启用。");
    return;
  }
  if (
    route.val.kind === "site" &&
    route.val.id === s.id &&
    (workspace?.hasDirty() || workspace?.hasSaving())
  ) {
    notify("请先保存或关闭未保存文件，再部署。");
    return;
  }
  const node = nodeForSite(s);
  if (!node) {
    notify("站点未绑定节点。");
    return;
  }
  const busy = van.state(false);
  const error = van.state("");
  const source = van.state("");
  const loaded = van.state(false);
  const dnsInfo = van.state(null);
  const diffInfo = van.state(null);
  modal(`部署 · ${s.name}`, (close) => {
    queueMicrotask(async () => {
      try {
        const [result, dns, diff] = await Promise.all([
          api.config(s.id),
          api.dns(s.id).catch((e) => ({ ok: false, summary: e.message, domains: [] })),
          api.deployPreview(s.id).catch((e) => ({ summary: e.message, note: "仍全量推送", first_deploy: true })),
        ]);
        source.val = result.source || "generated";
        dnsInfo.val = dns;
        diffInfo.val = diff;
        loaded.val = true;
      } catch (e) {
        error.val = e.message;
        showError(e);
      }
    });
    return div(
      { class: "deploy-preview" },
      p(
        { class: "pane-hint" },
        () =>
          `目标 ${node.host}${node.note ? " " + node.note : ""} · Caddy：${
            source.val === "custom" ? "自定义" : source.val ? "默认生成" : "读取中…"
          }`,
      ),
      p(
        { class: "pane-hint", role: "status", "aria-label": "部署变更摘要" },
        () => {
          const d = diffInfo.val;
          if (!d) return "对照上次部署…";
          return d.summary || "变更摘要不可用";
        },
      ),
      div(
        {
          class: "deploy-diff-list",
          hidden: () => {
            const d = diffInfo.val;
            return !d || !(d.added?.length || d.changed?.length || d.removed?.length);
          },
        },
        p(
          { class: "deploy-diff-line", hidden: () => !diffInfo.val?.added?.length },
          () =>
            diffInfo.val?.added?.length
              ? `新增：${diffInfo.val.added.join(", ")}`
              : "",
        ),
        p(
          { class: "deploy-diff-line", hidden: () => !diffInfo.val?.changed?.length },
          () =>
            diffInfo.val?.changed?.length
              ? `修改：${diffInfo.val.changed.join(", ")}`
              : "",
        ),
        p(
          { class: "deploy-diff-line", hidden: () => !diffInfo.val?.removed?.length },
          () =>
            diffInfo.val?.removed?.length
              ? `删除：${diffInfo.val.removed.join(", ")}`
              : "",
        ),
      ),
      p(
        { class: "pane-hint" },
        () => diffInfo.val?.note || "仍全量推送文件与 Caddy 配置。",
      ),
      p(
        { class: "pane-hint", role: "status" },
        () => {
          const d = dnsInfo.val;
          if (!d) return "DNS 检查中…";
          if (d.ok) return d.summary || "DNS 对照通过";
          return d.summary || "DNS 未通过";
        },
      ),
      () => {
        const d = dnsInfo.val;
        if (!d?.domains?.length) return null;
        return div(
          { class: "dns-list deploy-dns" },
          ...d.domains.map((row) =>
            p(
              {
                class: row.ok || row.skipped ? "dns-ok" : "dns-bad",
              },
              row.detail || row.host,
            ),
          ),
        );
      },
      p(
        {
          class: "pane-hint",
          role: "status",
          hidden: () => !dnsInfo.val?.ports?.length,
        },
        () => {
          const d = dnsInfo.val;
          if (!d?.ports?.length) return "";
          if (d.ports_ok) return "外网 :80/:443 主控可达";
          return "外网 :80/:443 主控不可达 — 自动 HTTPS 会失败";
        },
      ),
      () => {
        const d = dnsInfo.val;
        if (!d?.ports?.length) return null;
        return div(
          { class: "dns-list deploy-dns" },
          ...d.ports.map((row) =>
            p(
              { class: row.ok ? "dns-ok" : "dns-bad" },
              row.detail || `:${row.port}`,
            ),
          ),
        );
      },
      p({ class: "form-error", role: "alert" }, () => error.val),
      div(
        { class: "actions" },
        button(
          {
            type: "button",
            class: "btn primary",
            disabled: () => busy.val || !loaded.val,
            onclick: async () => {
              busy.val = true;
              error.val = "";
              try {
                if (await submitDeploy(s)) close();
              } catch (e) {
                error.val = e.message;
                showError(e);
              } finally {
                busy.val = false;
              }
            },
          },
          () => (busy.val ? "提交中…" : "部署"),
        ),
        button(
          {
            type: "button",
            class: "btn quiet",
            disabled: () => busy.val,
            onclick: () => close(),
          },
          "取消",
        ),
      ),
    );
  });
}
function sitesForNode(id) {
  return sites.val.filter((s) => s.node_id === id);
}
function unboundSites() {
  return sites.val.filter((s) => !s.node_id);
}

function activeTaskCount(siteId) {
  return tasks.val.filter(
    (t) => t.site_id === siteId && ["queued", "running"].includes(t.status),
  ).length;
}
function sitePayload(s, extra = {}) {
  return {
    name: s.name,
    domains: s.domains || [],
    port: s.port || 0,
    cert: s.cert || "off",
    mode: s.mode || "static",
    upstreams: s.upstreams || [],
    proxies: s.proxies || [],
    redir_https: s.redir_https,
    ...extra,
  };
}
async function copySiteToNode(s) {
  if (!nodes.val.length) {
    notify("先添加节点");
    return;
  }
  const choices = nodes.val
    .map((n, i) => `${i + 1}. ${n.host}${n.note ? " " + n.note : ""}`)
    .join("\n");
  const pick = prompt(`复制“${s.name}”到哪个节点？输入序号：\n${choices}`, "1");
  if (pick == null) return;
  const idx = Number(pick) - 1;
  const node = nodes.val[idx];
  if (!node) {
    notify("序号无效", "error");
    return;
  }
  const name = prompt("新站点名称", `${s.name} 副本`);
  if (name == null) return;
  const created = await api.copySite(s.id, {
    node_id: node.id,
    name: name.trim() || `${s.name} 副本`,
  });
  await load();
  navigate({ kind: "site", id: created.id });
  notify("已复制。换机：新节点点「更新」→「部署」→改 DNS；确认新站正常后再删原站。");
}
async function toggleSiteEnabled(s) {
  if (s.enabled === false) {
    const result = await api.enableSite(s.id);
    await load();
    // recreate workspace with fresh enabled flag; old closure otherwise blocks deploy
    navigate({ kind: "site", id: s.id }, { force: true });
    if (result.task_id) {
      await selectNewTask(result.task_id, s.node_id);
      notify("已启用，正在节点恢复 Caddy 站点", "success");
    } else {
      notify("已启用；若节点上没有备份，请再部署一次", "success");
    }
    return;
  }
  if (!confirm(`停用“${s.name}”？节点会保留域名占位并返回 503，避免流量落到别的站。`)) return;
  const result = await api.disableSite(s.id);
  await load();
  navigate({ kind: "site", id: s.id }, { force: true });
  if (result.task_id) await selectNewTask(result.task_id, s.node_id);
  notify("已停用：域名会回 503，不再落到别的站", "success");
}
async function removeSite(s) {
  if (!confirm(`删除站点“${s.name}”？会先尝试远端停用（配置清单变更）。`)) return;
  const purge = confirm("同时删除主控上的站点原件目录吗？取消=仅删记录并保留文件。");
  const nodeId = s.node_id || currentNodeId();
  const result = await api.deleteSite(s.id, {
    purge_master: purge,
    force_remote: true,
  });
  await load();
  // 站点记录已删，不能再 selectNewTask→openPane；留在节点页看远端停用任务
  if (nodeId && nodes.val.some((n) => n.id === nodeId)) {
    navigate({ kind: "node", id: nodeId }, { force: true });
    if (result.task_id) openNodeTaskLog(result.task_id);
  } else {
    const next = nodes.val[0];
    if (next) navigate({ kind: "node", id: next.id }, { force: true });
    else navigate({ kind: "draft-node" }, { force: true });
  }
  notify(result.task_id ? "站点已删除，正在远端停用" : "站点已删除", "success");
}
function siteRow(s) {
  const count = () => activeTaskCount(s.id);
  return div(
    {
      class: () =>
        `site-row ${
          route.val.kind === "site" && route.val.id === s.id ? "selected" : ""
        }${s.enabled === false ? " disabled" : ""}`,
      onclick: (event) => {
        if (event.target.closest("a,button,input,.site-row-actions"))
          return;
        openPane(s, "ssl");
      },
    },
    div(
      { class: "site-name" },
      div(
        { class: "site-name-line" },
        span(
          {
            class: "site-name-btn",
            title: "打开配置包",
          },
          s.enabled === false ? `${s.name}（停用）` : s.name,
        ),
        () =>
          count()
            ? span(
                { class: "task-dot", title: `${count()} 个进行中任务` },
                String(count()),
              )
            : null,
      ),
      span(
        {
          class: () =>
            `site-proto ${sslLabel(s.ssl, s) === "https" ? "is-https" : "is-http"}`,
          title: sslLabel(s.ssl, s),
        },
        sslLabel(s.ssl, s),
      ),
    ),
    div(
      { class: "domain-list" },
      ...s.domains.map((h) =>
        a(
          {
            class: s.enabled === false ? "domain-disabled" : "",
            href: siteHref(s, h),
            target: "_blank",
            rel: "noopener noreferrer",
            title:
              s.enabled === false
                ? `${domainLabel(s, h)}（已停用）`
                : domainLabel(s, h),
            onclick: (e) => e.stopPropagation(),
          },
          domainLabel(s, h),
        ),
      ),
    ),
    div(
      { class: "site-row-actions" },
      button(
        {
          type: "button",
          class: "icon-only",
          title: s.enabled === false ? "启用（远端）" : "停用（远端）",
          "aria-label": s.enabled === false ? "启用站点" : "停用站点",
          onclick: (e) => {
            e.stopPropagation();
            toggleSiteEnabled(s).catch(showError);
          },
        },
        icon(s.enabled === false ? "check" : "ban"),
      ),
      button(
        {
          type: "button",
          class: "icon-only",
          title: "复制到节点",
          "aria-label": "复制到节点",
          onclick: (e) => {
            e.stopPropagation();
            copySiteToNode(s).catch(showError);
          },
        },
        icon("copy"),
      ),
      button(
        {
          type: "button",
          class: "icon-only danger",
          title: "删除站点（远端停用 + 主控记录）",
          "aria-label": "删除站点",
          onclick: (e) => {
            e.stopPropagation();
            removeSite(s).catch(showError);
          },
        },
        icon("failed"),
      ),
    ),
  );
}
function overview() {
  return section(
    { class: "site-table-panel overview-panel", "aria-label": "站点列表" },
    div(
      { class: "mobile-list-nav" },
      span({ class: "pane-hint" }, "节点 / 站点"),
      button(
        {
          type: "button",
          class: "btn quiet",
          disabled: () => !route.val?.kind,
          onclick: () => {
            mobilePane.val = "work";
          },
        },
        "工作区 →",
      ),
    ),
    div(
      { class: "overview-tools" },
      div(
        { class: "overview-left" },
        act("添加 IP", startAddNode),
        act("TG 推送", startTelegram),
      ),
      div(
        { class: "overview-right" },
        act("检查全部", () => checkAllNodes().catch(showError), "icon-only"),
        act("刷新", load, "icon-only"),
        act("退出", logout, "icon-only"),
      ),
    ),
    div({ class: "overview-list" }, () => {
      const groups = [
        ...nodes.val.map((n) => ({
          key: n.id,
          title: `${n.host}${n.note ? "  " + n.note : ""}`,
          node: n,
          sites: sitesForNode(n.id),
        })),
      ];
      const free = unboundSites();
      if (free.length)
        groups.push({
          key: "unbound",
          title: "未绑定节点",
          node: null,
          sites: free,
        });
      if (!groups.length)
        return p({ class: "table-empty" }, "先添加节点，再创建站点。");
      return div(
        ...groups.map((g) =>
          div(
            { class: "node-group" },
            div(
              {
                class: () =>
                  `node-row ${
                    g.node &&
                    route.val.kind === "node" &&
                    route.val.id === g.node.id
                      ? "selected"
                      : ""
                  }`,
              },
              button(
                {
                  type: "button",
                  class: "node-row-main",
                  onclick: () => {
                    if (g.node) navigate({ kind: "node", id: g.node.id });
                  },
                },
                span({ class: "node-ip" }, g.title),
                g.sites.length
                  ? null
                  : span({ class: "node-empty" }, "无站点"),
              ),
              g.node
                ? div(
                    { class: "node-row-actions" },
                    button(
                      {
                        type: "button",
                        class: "icon-only node-action",
                        title: "添加站点",
                        "aria-label": "添加站点",
                        onclick: (e) => {
                          e.stopPropagation();
                          quickAddSite(g.node.id).catch(showError);
                        },
                      },
                      icon("plus"),
                    ),
                    button(
                      {
                        type: "button",
                        class: "icon-only node-action",
                        title: "安装 agent",
                        "aria-label": "安装 agent",
                        onclick: (e) => {
                          e.stopPropagation();
                          installNode(g.node.id).catch(showError);
                        },
                      },
                      icon("terminal"),
                    ),
                    button(
                      {
                        type: "button",
                        class: () => {
                          void nodeStatuses.val;
                          void nodeChecking.val;
                          const tone = nodeStatusTone(g.node.id);
                          return `icon-only node-action check-status is-${tone}`;
                        },
                        title: () => {
                          void nodeStatuses.val;
                          void nodeChecking.val;
                          return nodeCheckTitle(g.node.id);
                        },
                        "aria-label": "检查",
                        disabled: () => !!nodeChecking.val[g.node.id],
                        onclick: (e) => {
                          e.stopPropagation();
                          checkNode(g.node.id).catch(showError);
                        },
                      },
                      () => {
                        void nodeStatuses.val;
                        void nodeChecking.val;
                        return nodeCheckIcon(g.node.id);
                      },
                    ),
                  )
                : span(),
            ),
            g.sites.length
              ? div({ class: "site-rows" }, ...g.sites.map(siteRow))
              : null,
          ),
        ),
      );
    }),
  );
}
// Task state belongs to one node. Changing nodes cancels/invalidates old reads.
function resetTaskNode(id = "") {
  if (taskNode === id) return false;
  taskNode = id;
  notice.val = null;
  taskEpoch++;
  logEpoch++;
  logAbort?.abort();
  tasks.val = [];
  selectedTask.val = "";
  logLoading.val = false;
  logError.val = "";
  logTime.val = "";
  logText.val = "点击任务查看日志。";
  lastLogSignature = "";
  return true;
}
async function refreshTasks() {
  const id = currentNodeId();
  resetTaskNode(id);
  if (!id) return;
  const epoch = ++taskEpoch;
  let result;
  try {
    result = await api.tasks(id);
  } catch (error) {
    if (epoch === taskEpoch && currentNodeId() === id) throw error;
    return;
  }
  if (epoch !== taskEpoch || currentNodeId() !== id || !authenticated.val)
    return;
  tasks.val = result.filter((t) => t.node_id === id);
  if (
    view.val === "tasks" &&
    !tasks.val.some((t) => t.id === selectedTask.val)
  ) {
    if (tasks.val[0]) chooseTask(tasks.val[0].id);
    else {
      selectedTask.val = "";
      logText.val = "当前节点没有任务。";
    }
  }
}
async function selectNewTask(id, nodeId = currentNodeId()) {
  if (nodeId !== currentNodeId()) {
    notify("任务已提交，切回对应节点查看。");
    return;
  }
  if (selectedTask.val !== id) {
    logText.val = "读取中…";
    logError.val = "";
  }
  selectedTask.val = id;
  lastLogSignature = "";
  await refreshTasks();
  if (nodeId !== currentNodeId()) return;
  const task = tasks.val.find((t) => t.id === id && t.node_id === nodeId);
  const siteId = task?.site_id || "";
  const siteAlive = siteId && sites.val.some((s) => s.id === siteId);
  if (siteAlive) {
    view.val = "workspace";
    if (route.val.kind !== "site" || route.val.id !== siteId || !workspace) {
      navigate({ kind: "site", id: siteId }, { force: true });
    }
    workspace?.openPane?.("logs");
    if (task) chooseTask(id);
    else loadLogs(id);
  } else {
    // 节点任务，或站点已删（删站后的远端停用）：弹窗看日志
    view.val = "workspace";
    if (route.val.kind !== "node" || route.val.id !== nodeId || !workspace) {
      navigate({ kind: "node", id: nodeId }, { force: true });
    }
    openNodeTaskLog(id);
  }
}
function openNodeTaskLog(id) {
  if (!id) return;
  chooseTask(id);
  const title =
    taskName(tasks.val.find((t) => t.id === id) || {}) || "任务日志";
  modal(title, (close) =>
    div(
      { class: "node-log-dialog" },
      div(
        { class: "log-toolbar" },
        span(() => (logLoading.val ? "读取中…" : title)),
        div(
          { class: "actions" },
          act("刷新日志", () => loadLogs(), "quiet", () => !selectedTask.val),
          act(
            "复制日志",
            () => navigator.clipboard.writeText(logText.val || ""),
            "quiet",
            () => !selectedTask.val,
          ),
          act("下载日志", downloadLog, "quiet", () => !selectedTask.val),
        ),
      ),
      div(
        { class: "log-warning", hidden: () => !logError.val },
        () => logError.val || "",
      ),
      pre(
        {
          class: "log-output node-log-dialog-output",
          tabindex: 0,
          "aria-label": "节点任务日志",
        },
        () => logText.val || "读取中…",
      ),
    ),
  );
}
function openTasks() {
  // 兼容旧入口：节点任务改弹窗，不再跳独立页
  const task = tasks.val.find((t) => t.id === selectedTask.val) || tasks.val[0];
  if (task) openNodeTaskLog(task.id);
  else notify("当前节点没有任务。");
  refreshTasks().catch(showError);
}
function openSiteLogs(site) {
  openPane(site, "logs");
  const task = tasks.val.find((t) => t.site_id === site.id);
  if (task) chooseTask(task.id);
  else notify("此站点暂无任务记录。");
}
function chooseTask(id, { showPanel = false } = {}) {
  if (!tasks.val.some((t) => t.id === id && t.node_id === currentNodeId()))
    return;
  if (showPanel) {
    view.val = "workspace";
    if (route.val.kind === "site") workspace?.openPane?.("logs");
  }
  if (selectedTask.val !== id) {
    logText.val = "读取中…";
    logError.val = "";
  }
  selectedTask.val = id;
  lastLogSignature = "";
  loadLogs(id);
}
async function loadLogs(id = selectedTask.val) {
  const nodeId = currentNodeId();
  if (
    !id ||
    !authenticated.val ||
    expired.val ||
    !tasks.val.some((t) => t.id === id && t.node_id === nodeId)
  )
    return;
  if (logLoading.val && logAbort?.taskId === id) return;
  logAbort?.abort();
  const controller = new AbortController();
  controller.taskId = id;
  logAbort = controller;
  const epoch = ++logEpoch;
  logLoading.val = true;
  logError.val = "";
  try {
    const result = await api.taskLogs(id, nodeId, controller.signal);
    if (
      epoch !== logEpoch ||
      currentNodeId() !== nodeId ||
      selectedTask.val !== id ||
      !authenticated.val
    )
      return;
    const stick =
      !logScroll ||
      logScroll.scrollHeight - logScroll.scrollTop - logScroll.clientHeight <
        40;
    logText.val = result.text;
    logError.val = result.remote_error;
    logTime.val = result.observed_at;
    const t = tasks.val.find((t) => t.id === id);
    lastLogSignature = t
      ? `${t.id}:${t.status}:${t.step}:${t.error || ""}`
      : "";
    if (stick)
      setTimeout(() => {
        if (logScroll && currentNodeId() === nodeId && selectedTask.val === id)
          logScroll.scrollTop = logScroll.scrollHeight;
      }, 0);
  } catch (e) {
    if (e.name !== "AbortError" && epoch === logEpoch) {
      logError.val = e.message;
      if (e.status === 401) showError(e);
    }
  } finally {
    if (epoch === logEpoch) logLoading.val = false;
  }
}
async function poll() {
  if (!authenticated.val || expired.val || polling) return;
  polling = true;
  const nodeId = currentNodeId(),
    previous = tasks.val;
  try {
    for (const t of previous
      .filter(
        (t) =>
          t.node_id === nodeId &&
          t.site_id &&
          ["running", "needs_attention"].includes(t.status) &&
          t.step !== "prepare",
      )
      .slice(0, 4)) {
      if (currentNodeId() !== nodeId) return;
      try {
        await api.refreshTask(t.id, nodeId);
      } catch (e) {
        if (e.status === 401) throw e;
        if (currentNodeId() === nodeId && selectedTask.val === t.id)
          logError.val = e.message;
      }
    }
    if (currentNodeId() !== nodeId) return;
    await refreshTasks();
    if (currentNodeId() !== nodeId) return;
    if (
      tasks.val.some(
        (t) =>
          t.kind === "ssl" &&
          t.status === "succeeded" &&
          previous.find((p) => p.id === t.id)?.status !== "succeeded",
      )
    ) {
      sites.val = await api.sites();
      if (route.val.kind === "site")
        workspace?.updateSSL(sites.val.find((s) => s.id === route.val.id)?.ssl);
    }
    const t = tasks.val.find((t) => t.id === selectedTask.val);
    if (
      t &&
      (["running", "queued"].includes(t.status) ||
        lastLogSignature !== `${t.id}:${t.status}:${t.step}:${t.error || ""}`)
    )
      loadLogs(t.id);
  } catch (e) {
    showError(e);
  } finally {
    polling = false;
  }
}
function statusBadge(status) {
  const glyph =
    status === "succeeded"
      ? "success"
      : status === "failed" || status === "dismissed"
        ? "failed"
        : status === "needs_attention"
          ? "warning"
          : "clock";
  return span(
    { class: `task-status ${status}` },
    icon(glyph),
    taskLabels[status] || status,
  );
}
function downloadLog() {
  const url = URL.createObjectURL(
    new Blob([logText.val], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `site-panel-${selectedTask.val}.log`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function taskPanel() {
  logScroll = pre(
    { class: "log-output", tabindex: 0, "aria-label": "执行日志" },
    () => logText.val,
  );
  return section(
    {
      class: "task-panel",
      hidden: () => view.val !== "tasks",
      "aria-label": "当前节点任务日志",
    },
    div(
      { class: "task-panel-toolbar" },
      span(() => `任务 · ${currentNode()?.host || "未选择节点"}`),
      div(
        { class: "actions" },
        act("刷新任务", poll),
        act(
          "清除待核实",
          async () => {
            const id = currentNodeId();
            if (!id) return;
            const r = await api.dismissNodeAttention(id);
            await refreshTasks();
            notify(r.dismissed ? `已清除 ${r.dismissed} 条待核实` : "没有待核实任务");
          },
          "",
          () => !tasks.val.some((t) => t.status === "needs_attention"),
        ),
        act("返回工作区", () => {
          view.val = "workspace";
        }),
      ),
    ),
    div(
      { class: "tasks-layout" },
      div(
        { class: "task-table-wrap" },
        table(thead(tr(th("任务"), th("状态"), th("更新"))), () =>
          tbody(
            ...tasks.val.map((t) =>
              tr(
                { class: () => (selectedTask.val === t.id ? "selected" : "") },
                td(
                  button(
                    {
                      type: "button",
                      class: "task-link text-button",
                      onclick: () => chooseTask(t.id),
                    },
                    taskName(t),
                  ),
                  small(
                    `${stepLabels[t.step] || t.step} · ${t.id.slice(0, 8)}`,
                  ),
                ),
                td(statusBadge(t.status)),
                td({ class: "task-time" }, timeLabel(t.updated_at)),
              ),
            ),
          ),
        ),
        () =>
          tasks.val.length
            ? div()
            : p({ class: "table-empty" }, "当前节点没有任务。"),
      ),
      div(
        { class: "log-pane" },
        div(
          { class: "log-toolbar" },
          span(
            {
              title: () =>
                logTime.val ? `采集 ${timeLabel(logTime.val)}` : "",
            },
            () =>
              logLoading.val
                ? "读取中…"
                : selectedTask.val
                  ? taskName(
                      tasks.val.find((t) => t.id === selectedTask.val) || {},
                    )
                  : "日志",
          ),
          div(
            { class: "actions" },
            () => {
              const t = tasks.val.find((x) => x.id === selectedTask.val);
              return t?.status === "needs_attention"
                ? act("知道了", async () => {
                    await api.dismissTask(t.id, currentNodeId());
                    await refreshTasks();
                    notify("已忽略这条待核实");
                  })
                : span();
            },
            act(
              "刷新日志",
              () => loadLogs(),
              "icon-only",
              () => !selectedTask.val,
            ),
            act(
              "复制日志",
              () => navigator.clipboard.writeText(logText.val),
              "icon-only",
              () => !selectedTask.val,
            ),
            act("下载日志", downloadLog, "icon-only", () => !selectedTask.val),
          ),
        ),
        div(
          { class: "log-warning", hidden: () => !logError.val },
          () => logError.val,
        ),
        logScroll,
      ),
    ),
  );
}
function statusbar() {
  return div(
    { class: "statusbar", role: "status" },
    button(
      {
        type: "button",
        class: "status-log-link",
        onclick: openTasks,
        title: "当前节点任务与日志",
      },
      icon("logs"),
      span(() => `任务/日志 ${tasks.val.length}`),
    ),
    span(
      {
        class: () => `status-message ${notice.val?.tone || ""}`,
        title: () => notice.val?.text || "",
      },
      () => notice.val?.text || (expired.val ? "登录过期" : "就绪"),
    ),
    span({ class: "status-context" }, () => {
      const task = tasks.val[0];
      return task ? `最近：${taskName(task)} · ${taskLabels[task.status] || task.status} / ${stepLabels[task.step] || task.step}` : "";
    }),
    act("刷新任务", poll, "icon-only"),
    button(
      {
        type: "button",
        class: "btn",
        hidden: () => !expired.val,
        onclick: reauthenticate,
      },
      "重新登录",
    ),
  );
}
function toast() {
  return div(
    {
      class: () => `toast ${notice.val?.tone || ""}`,
      hidden: () => !notice.val?.text && !expired.val,
      role: "status",
    },
    span(() => notice.val?.text || (expired.val ? "登录过期" : "")),
    button(
      {
        type: "button",
        class: "btn",
        hidden: () => !expired.val,
        onclick: reauthenticate,
      },
      "重新登录",
    ),
    button(
      {
        type: "button",
        class: "btn icon-only",
        hidden: () => !notice.val?.text,
        title: "关闭提示",
        "aria-label": "关闭提示",
        onclick: () => {
          notice.val = null;
        },
      },
      icon("close"),
    ),
  );
}
function shell() {
  workMount = div({
    class: "workspace-slot",
    hidden: () => view.val !== "workspace",
  });
  const element = div(
    { class: "app-shell" },
    div(
      { class: "main-shell" },
      div(
        {
          class: () =>
            `content-row ${mobilePane.val === "list" ? "show-list" : "show-work"}`,
        },
        section({ class: "sites-panel", "aria-label": "站点区" }, overview()),
        main(
          { class: "work-area" },
          div(
            { class: "mobile-nav" },
            button(
              {
                type: "button",
                class: "btn quiet",
                onclick: () => {
                  mobilePane.val = "list";
                },
              },
              "← 节点列表",
            ),
            span({ class: "pane-hint" }, () => {
              if (route.val.kind === "site") {
                const s = sites.val.find((x) => x.id === route.val.id);
                return s?.name || "站点";
              }
              if (route.val.kind === "node") {
                const n = nodes.val.find((x) => x.id === route.val.id);
                return n ? `${n.host}${n.note ? " · " + n.note : ""}` : "节点";
              }
              if (route.val.kind === "draft-node") return "添加 IP";
              if (route.val.kind === "telegram") return "TG 推送";
              return "工作区";
            }),
          ),
          workMount,
        ),
      ),
      toast(),
    ),
  );
  queueMicrotask(showInitial);
  return element;
}
van.add(document.querySelector("#app"), () =>
  authenticated.val ? shell() : authView(),
);
try {
  const s = await api.session();
  initialized.val = s.initialized;
  authenticated.val = s.authenticated;
  setCSRF(s.csrf);
  if (s.authenticated) await load();
} catch (e) {
  notify(e.message, "error");
}
const timer = setInterval(() => {
  if (document.visibilityState === "visible") poll();
}, 4000);
window.addEventListener("pagehide", (e) => {
  logAbort?.abort();
  if (!e.persisted) {
    clearInterval(timer);
    workspace?.dispose();
  }
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) poll();
});
