import van from "../vendor/van-1.6.1.js";
import { api } from "./api.js";
import { action, icon } from "./ui.js";
import { domainLabel } from "./ssl.js";

const MIN_AGENT = "0.2.8";

function agentOutdated(version) {
  if (!version) return false;
  const parts = String(version).split(".").map((n) => Number(n) || 0);
  const want = MIN_AGENT.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) < (want[i] || 0)) return true;
    if ((parts[i] || 0) > (want[i] || 0)) return false;
  }
  return false;
}

const {
  button,
  div,
  h3,
  input,
  p,
  section,
  span,
  table,
  tbody,
  td,
  th,
  thead,
  tr,
} = van.tags;

function shortFp(fp = "") {
  if (!fp) return "—";
  if (fp.length <= 28) return fp;
  return `${fp.slice(0, 18)}…${fp.slice(-8)}`;
}

function kindLabel(kind) {
  return (
    {
      deploy: "部署",
      ssl: "SSL",
      disable: "停用",
      enable: "启用",
      install: "安装 agent",
    }[kind] ||
    kind ||
    "任务"
  );
}

export function createNodeWorkspace(
  node,
  {
    notify,
    onError,
    onInstall,
    onOpenSite,
    onChooseTask,
    onUpdated,
    onTelegram,
    nodeSites,
    nodeTasks,
    timeLabel,
    statusBadge,
  },
) {
  const status = van.state(null);
  const statusError = van.state("");
  const busy = van.state(false);
  const note = van.state(node.note || "");
  const editingNote = van.state(false);
  const noteBusy = van.state(false);
  const fpBusy = van.state(false);
  const pendingFp = van.state("");
  const fpMsg = van.state("");
  const pwBusy = van.state(false);
  const pwMsg = van.state("");
  let disposed = false;
  let statusEpoch = 0;
  const passwordInput = input({
    class: "node-note-input",
    type: "password",
    value: "",
    autocomplete: "new-password",
    placeholder: "已存密码不显示；填新密码后保存",
    "aria-label": "SSH 密码",
  });
  const noteInput = input({
    class: "node-note-input",
    value: note.val,
    placeholder: "备注",
    "aria-label": "节点备注",
    oninput: (e) => (note.val = e.target.value),
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveNote().catch(onError);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancelNote();
      }
    },
  });

  async function refreshStatus({ quiet = false } = {}) {
    if (disposed) return;
    const epoch = ++statusEpoch;
    busy.val = true;
    statusError.val = "";
    try {
      const result = await api.status(node.id);
      if (disposed || epoch !== statusEpoch) return;
      status.val = result;
      if (!quiet) {
        notify(
          `${node.host}：Nginx ${result.nginx || "?"}，agent ${result.version || "?"}`,
          "success",
        );
      }
    } catch (e) {
      if (disposed || epoch !== statusEpoch) return;
      status.val = null;
      statusError.val = e.message || "检查失败";
      if (!quiet) onError(e);
    } finally {
      if (epoch === statusEpoch) busy.val = false;
    }
  }

  function startEditNote() {
    note.val = node.note || "";
    noteInput.value = note.val;
    editingNote.val = true;
    queueMicrotask(() => {
      noteInput.focus();
      noteInput.select();
    });
  }

  function cancelNote() {
    note.val = node.note || "";
    noteInput.value = note.val;
    editingNote.val = false;
  }

  async function saveNote() {
    if (noteBusy.val) return;
    const next = noteInput.value.trim();
    if (next === (node.note || "")) {
      editingNote.val = false;
      return;
    }
    noteBusy.val = true;
    try {
      const updated = await api.updateNode(node.id, {
        name: node.name,
        note: next,
      });
      if (disposed) return;
      node.note = updated.note || "";
      node.name = updated.name || node.name;
      note.val = node.note;
      noteInput.value = node.note;
      editingNote.val = false;
      notify("节点备注已保存", "success");
      await onUpdated?.();
    } catch (e) {
      onError(e);
    } finally {
      noteBusy.val = false;
    }
  }

  async function savePassword() {
    if (pwBusy.val) return;
    const next = passwordInput.value;
    if (!next.trim()) {
      pwMsg.val = "请填写新的 SSH 密码";
      return;
    }
    pwBusy.val = true;
    pwMsg.val = "";
    try {
      await api.updateNode(node.id, {
        name: node.name,
        note: node.note || "",
        password: next,
      });
      if (disposed) return;
      passwordInput.value = "";
      let extra = "";
      try {
        const probed = await api.probe({
          host: node.host,
          port: node.port || 22,
          user: node.user || "root",
        });
        const live = probed.fingerprint || "";
        if (live && live !== node.fingerprint) {
          const r = await api.updateNodeFingerprint(node.id, live);
          const updated = r.node || r;
          node.fingerprint = updated.fingerprint || live;
          pendingFp.val = "";
          extra = "；指纹已一并更新";
        }
      } catch (_) {
        extra = "；指纹未改，可点「重认指纹」";
      }
      pwMsg.val = "密码已更新（不回显）" + extra;
      notify("SSH 密码已更新" + extra, "success");
      await onUpdated?.();
    } catch (e) {
      onError(e);
    } finally {
      pwBusy.val = false;
    }
  }


  async function probeFingerprint({ confirmIfChanged = false } = {}) {
    if (fpBusy.val) return;
    fpBusy.val = true;
    fpMsg.val = "";
    try {
      const result = await api.probe({
        host: node.host,
        port: node.port || 22,
        user: node.user || "root",
      });
      if (disposed) return;
      pendingFp.val = result.fingerprint || "";
      if (!pendingFp.val) {
        fpMsg.val = "未读到指纹";
        return;
      }
      if (pendingFp.val === node.fingerprint) {
        fpMsg.val = "与已存指纹一致，无需更新";
        notify(fpMsg.val, "success");
        return;
      }
      fpMsg.val = "主机指纹已变化，确认是你的机器后再更新";
      if (confirmIfChanged) {
        const ok = window.confirm(
          `主机 SSH 指纹已变化。\n已存：${node.fingerprint || "（无）"}\n当前：${pendingFp.val}\n\n确认这是你的机器后再更新（重装/换密钥时正常）。`,
        );
        if (ok) {
          fpBusy.val = false;
          await confirmFingerprint();
          return;
        }
      }
    } catch (e) {
      pendingFp.val = "";
      onError(e);
    } finally {
      fpBusy.val = false;
    }
  }

  async function confirmFingerprint() {
    if (fpBusy.val || !pendingFp.val) return;
    if (pendingFp.val === node.fingerprint) {
      fpMsg.val = "与已存指纹一致，无需更新";
      return;
    }
    fpBusy.val = true;
    try {
      const r = await api.updateNodeFingerprint(node.id, pendingFp.val);
      if (disposed) return;
      const updated = r.node || r;
      node.fingerprint = updated.fingerprint || pendingFp.val;
      pendingFp.val = "";
      fpMsg.val = r.changed === false ? "指纹未变化" : "指纹已更新，可重新部署";
      notify(fpMsg.val, "success");
      await onUpdated?.();
    } catch (e) {
      onError(e);
    } finally {
      fpBusy.val = false;
    }
  }

  const sites = () => nodeSites() || [];
  const tasks = () => (nodeTasks() || []).slice(0, 12);
  const enabledCount = () => sites().filter((s) => s.enabled !== false).length;
  const disabledCount = () => sites().filter((s) => s.enabled === false).length;
  const ports = () =>
    [
      ...new Set(
        sites()
          .flatMap((s) => {
            const list = [s.port];
            if (s.ssl?.applied) list.push(443);
            return list;
          })
          .filter(Boolean),
      ),
    ].sort((a, b) => a - b);

  const element = section(
    { class: "node-workspace", "aria-label": "节点工作区" },
    div(
      { class: "workspace-toolbar node-toolbar" },
      div(
        { class: "node-heading" },
        span({ class: "node-heading-host" }, node.host),
        span({ class: "node-heading-note" }, () => note.val || node.name || ""),
      ),
      div(
        { class: "actions" },
        action("检查", () => refreshStatus(), {
          glyph: "diagnose",
          kind: "quiet",
          onError,
          disabled: () => busy.val,
        }),
        action("更新", () => onInstall?.(), {
          glyph: "terminal",
          onError,
          disabled: () => busy.val,
        }),
        action("重认指纹", () => probeFingerprint({ confirmIfChanged: true }), {
          glyph: "lock",
          kind: "quiet",
          onError,
          disabled: () => fpBusy.val,
          title: "主机重装/换密钥后点这里",
        }),
      ),
    ),
    div(
      { class: "node-pane" },
      section(
        { class: "node-card" },
        h3("Agent"),
        () =>
          statusError.val
            ? p({ class: "form-error", role: "alert" }, statusError.val)
            : span(),
        table(
          { class: "node-meta" },
          tbody(
            tr(
              th("版本"),
              td(() => {
                const v = status.val?.version;
                if (!v) return busy.val ? "检查中…" : "未检查";
                if (agentOutdated(v))
                  return `${v}（过旧，请先更新，最低 ${MIN_AGENT}）`;
                return v;
              }),
            ),
            tr(
              th("Nginx"),
              td(() => status.val?.nginx || (busy.val ? "检查中…" : "—")),
            ),
            tr(
              th("检查时间"),
              td(() =>
                status.val?.observed_at
                  ? timeLabel(status.val.observed_at)
                  : "—",
              ),
            ),
          ),
        ),
        p(
          { class: "field-hint" },
          "执行器只负责部署/停用/启用/SSL；需要时再点检查。",
        ),
      ),
      section(
        { class: "node-card" },
        h3("机器"),
        table(
          { class: "node-meta" },
          tbody(
            tr(
              th("SSH"),
              td(`${node.user || "root"}@${node.host}:${node.port || 22}`),
            ),
            tr(
              th("密码"),
              td(
                { class: "node-note-cell" },
                div(
                  { class: "node-note-edit" },
                  passwordInput,
                  button(
                    {
                      type: "button",
                      class: "btn quiet",
                      title: "保存新的 SSH 密码",
                      "aria-label": "保存 SSH 密码",
                      disabled: () => pwBusy.val,
                      onclick: () => savePassword().catch(onError),
                    },
                    "保存密码",
                  ),
                ),
                () =>
                  pwMsg.val
                    ? p({ class: "field-hint" }, () => pwMsg.val)
                    : p(
                        { class: "field-hint" },
                        "密码加密存放，界面不显示。维护改密后在这里覆盖。",
                      ),
              ),
            ),
            tr(
              th("指纹"),
              td(
                { class: "node-fp-cell" },
                div(
                  {
                    title: () => pendingFp.val || node.fingerprint || "",
                    class: "mono",
                  },
                  () => shortFp(pendingFp.val || node.fingerprint),
                ),
                div(
                  { class: "node-fp-actions" },
                  button(
                    {
                      type: "button",
                      class: "btn quiet",
                      title: "读取当前主机 SSH 指纹",
                      "aria-label": "读取当前主机 SSH 指纹",
                      disabled: () => fpBusy.val,
                      onclick: () => probeFingerprint().catch(onError),
                    },
                    "读取指纹",
                  ),
                  button(
                    {
                      type: "button",
                      class: "btn quiet",
                      title: "确认并更新已存指纹",
                      "aria-label": "确认并更新已存指纹",
                      disabled: () =>
                        fpBusy.val ||
                        !pendingFp.val ||
                        pendingFp.val === node.fingerprint,
                      onclick: () => confirmFingerprint().catch(onError),
                    },
                    "确认更新",
                  ),
                ),
                () =>
                  fpMsg.val
                    ? p({ class: "field-hint" }, () => fpMsg.val)
                    : span(),
              ),
            ),
            tr(
              th("备注"),
              td(
                { class: "node-note-cell" },
                () =>
                  editingNote.val
                    ? div(
                        { class: "node-note-edit" },
                        noteInput,
                        button(
                          {
                            type: "button",
                            class: "btn quiet",
                            disabled: () => noteBusy.val,
                            onclick: () => saveNote().catch(onError),
                          },
                          "保存",
                        ),
                        button(
                          {
                            type: "button",
                            class: "btn quiet",
                            disabled: () => noteBusy.val,
                            onclick: cancelNote,
                          },
                          "取消",
                        ),
                      )
                    : div(
                        { class: "node-note-view" },
                        span(() => note.val || "—"),
                        button(
                          {
                            type: "button",
                            class: "icon-only",
                            title: "改备注",
                            "aria-label": "改备注",
                            onclick: startEditNote,
                          },
                          icon("pencil"),
                        ),
                      ),
              ),
            ),
          ),
        ),
      ),
      section(
        { class: "node-card" },
        h3(() => {
          const all = sites();
          return `本机站点 · ${all.length}（启用 ${enabledCount()} / 停用 ${disabledCount()}）`;
        }),
        p(
          { class: "field-hint" },
          () => {
            const list = ports();
            return list.length
              ? `占用端口：${list.join(", ")}`
              : "还没有站点。";
          },
        ),
        () => {
          const all = sites();
          if (!all.length)
            return p({ class: "table-empty" }, "此节点还没有站点。");
          return table(
            { class: "node-sites" },
            thead(tr(th("站点"), th("域名"), th("端口"), th("状态"))),
            tbody(
              ...all.map((s) =>
                tr(
                  {
                    class: s.enabled === false ? "disabled" : "",
                    onclick: () => onOpenSite?.(s),
                  },
                  td(s.name),
                  td(
                    { class: "domain-cell" },
                    (s.domains || [])
                      .slice(0, 3)
                      .map((h) => domainLabel(s, h))
                      .join(" · ") || "—",
                  ),
                  td(String(s.port || "—")),
                  td(s.enabled === false ? "停用" : "启用"),
                ),
              ),
            ),
          );
        },
      ),
      section(
        { class: "node-card" },
        h3("最近任务"),
        () => {
          const list = tasks();
          if (!list.length)
            return p({ class: "table-empty" }, "这个节点还没有任务记录。");
          return table(
            { class: "node-tasks" },
            thead(tr(th("类型"), th("对象"), th("状态"), th("时间"))),
            tbody(
              ...list.map((t) =>
                tr(
                  {
                    onclick: () => onChooseTask?.(t),
                  },
                  td(kindLabel(t.kind)),
                  td(
                    t.site_id
                      ? sites().find((s) => s.id === t.site_id)?.name || "站点"
                      : "节点",
                  ),
                  td(statusBadge(t.status)),
                  td(timeLabel(t.updated_at || t.created_at)),
                ),
              ),
            ),
          );
        },
      ),
      section(
        { class: "node-card muted" },
        h3("计划任务"),
        p(
          { class: "field-hint" },
          "以后在这里加巡检/续期/定时部署。现在先留位，避免和站点工作区混在一起。",
        ),
      ),
      section(
        { class: "node-card" },
        h3("Telegram 总览"),
        p(
          { class: "field-hint" },
          "专用 bot：每天 06:00 / 18:00 全检汇报，只留最新一条；也可在此手动推送。",
        ),
        div(
          { class: "row", style: "margin-top:6px" },
          button(
            {
              type: "button",
              class: "btn",
              onclick: () => onTelegram?.(),
            },
            "配置 / 推送",
          ),
        ),
      ),
    ),
  );

  return {
    element,
    refreshStatus,
    canLeave() {
      return true;
    },
    dispose() {
      disposed = true;
      statusEpoch++;
    },
  };
}
