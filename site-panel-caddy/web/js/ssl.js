import van from "../vendor/van-1.6.1.js";
import { api } from "./api.js";
import { action, icon } from "./ui.js";
import { createVarsPane } from "./vars.js";
const { button, div, input, label, p, span, textarea, ul, li, table, tbody, td, tr } = van.tags;

function parseListen(raw) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (/^https?:\/\//.test(v)) return null;
  const m = v.match(/^(.*?):(\d{1,5})$/);
  if (m && !v.startsWith("[")) {
    const port = Number(m[2]);
    if (port < 1 || port > 65535 || port === 22) return null;
    return { host: m[1], port, raw: `${m[1]}:${port}` };
  }
  return { host: v, port: 0, raw: v };
}

function isIPHost(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function certModeOf(site) {
  const c = String(site?.cert || "").toLowerCase();
  if (c === "auto" || c === "off" || c === "custom") return c;
  const domains = site?.domains || [];
  for (const row of domains) {
    const l = parseListen(row);
    if (l && !isIPHost(l.host) && !l.port) return "auto";
  }
  return domains.length ? "off" : "auto";
}

export function parseDomainText(text) {
  const list = [];
  const seen = new Set();
  for (const row of String(text || "")
    .split(/[\n,，\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)) {
    const l = parseListen(row);
    if (!l) throw new Error(`域名无效: ${row}`);
    if (seen.has(l.raw)) throw new Error(`重复域名: ${l.raw}`);
    seen.add(l.raw);
    list.push(l.raw);
  }
  return list;
}


function autoGrow(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.max(el.scrollHeight, 72)}px`;
}

function bindAutoGrow(el, text) {
  queueMicrotask(() => autoGrow(el));
  van.derive(() => {
    text.val;
    queueMicrotask(() => autoGrow(el));
  });
  return el;
}

function proxyRowsOf(site) {
  const list = site?.proxies || [];
  if (list.length) {
    return list.map((r) => ({
      path: r.path || "",
      upstream: r.upstream || "",
    }));
  }
  return [];
}

/** Left overview badge: only http / https. */
export function sslLabel(_info, site) {
  return certModeOf(site || { cert: "auto" }) === "off" ? "http" : "https";
}

export function domainLabel(_site, h) {
  const l = parseListen(h);
  return l?.raw || h;
}

export function siteHref(site, h) {
  const l = parseListen(h);
  if (!l) return "#";
  if (isIPHost(l.host) || l.port) {
    const port = l.port || site.port || 80;
    const host = l.host.includes(":") ? `[${l.host}]` : l.host;
    return `http://${host}:${port}/`;
  }
  const mode = certModeOf(site);
  if (mode !== "off" && site.ssl?.applied) return `https://${l.host}/`;
  return `http://${l.host}/`;
}

function dnsRowText(row, nodeIP) {
  if (row.skipped) return `${row.host}：跳过`;
  if (row.ok) {
    const ips = (row.ips || []).join(", ") || "?";
    return `${row.host}：${ips}`;
  }
  if (row.error || /解析失败/.test(row.detail || "")) {
    return `${row.host}：没有解析`;
  }
  const ips = (row.ips || []).join(", ");
  if (ips) return `${row.host}：${ips} ≠ ${nodeIP || "节点"}`;
  return row.detail || `${row.host}：未通过`;
}

export function onlyIPListens(list) {
  if (!list.length) return false;
  return list.every((row) => {
    const l = parseListen(row);
    return l && (isIPHost(l.host) || l.port);
  });
}

/** Parse domain box → list + whether SSL should force off. */
export function normalizeDomains(text) {
  const list = parseDomainText(text);
  return { list, httpsOff: onlyIPListens(list) };
}

export function createSSLPane(
  site,
  { onError, notify, onUpdated, onConfigSynced },
) {
  const info = van.state(site.ssl || null);
  const siteName = van.state(site.name || "");
  const domainsText = van.state((site.domains || []).join("\n"));
  const httpsOn = van.state(certModeOf(site) !== "off");
  const proxies = van.state(proxyRowsOf(site));
  const busy = van.state(false);
  const status = van.state("");
  const dnsInfo = van.state(null);
  const dnsBusy = van.state(false);
  const varsPane = createVarsPane(site, { onError, notify });
  const nameInput = input({
    value: () => siteName.val,
    placeholder: "站点名称",
    "aria-label": "站点名称",
    oninput: (e) => (siteName.val = e.target.value),
  });

  function syncHttpsFromDomains() {
    try {
      if (normalizeDomains(domainsText.val).httpsOff) httpsOn.val = false;
    } catch {
      /* typing incomplete row */
    }
  }

  const domainBox = textarea({
    class: "domain-textarea autosize",
    value: () => domainsText.val,
    oninput: (e) => {
      domainsText.val = e.target.value;
      autoGrow(e.target);
      syncHttpsFromDomains();
    },
    placeholder: "test.yyy.cn\n1.2.3.4:8888",
    spellcheck: false,
  });
  bindAutoGrow(domainBox, domainsText);

  async function refreshDNS() {
    dnsBusy.val = true;
    try {
      if (!busy.val) {
        try {
          await save({ quiet: true });
        } catch {
          /* still try with last saved */
        }
      }
      dnsInfo.val = await api.dns(site.id);
    } catch (error) {
      dnsInfo.val = {
        ok: false,
        summary: error.message,
        domains: [],
        node_ip: "",
      };
      onError(error);
    } finally {
      dnsBusy.val = false;
    }
  }

  const collectProxies = () => {
    const out = [];
    const seen = new Set();
    for (const row of proxies.val) {
      const path = String(row.path || "").trim();
      const upstream = String(row.upstream || "").trim();
      if (!path && !upstream) continue;
      if (!path.startsWith("/") || /\s|\{/.test(path)) {
        throw new Error(`反代路径无效: ${path || "(空)"}`);
      }
      if (!upstream) throw new Error(`反代上游不能为空: ${path}`);
      const key = path.replace(/\/+$/, "") || "/";
      if (seen.has(key)) throw new Error(`反代路径重复: ${key}`);
      seen.add(key);
      out.push({ path: key, upstream });
    }
    return out;
  };

  const save = async ({ quiet = false } = {}) => {
    if (busy.val) return site;
    const { list, httpsOff } = normalizeDomains(domainsText.val);
    if (!list.length) throw new Error("至少填一个域名");
    if (httpsOff) httpsOn.val = false;
    const proxyList = collectProxies();
    const vars = varsPane.collect();
    busy.val = true;
    status.val = "";
    try {
      const name = String(siteName.val || "").trim();
      if (!name) throw new Error("站点名称不能为空");
      const result = await api.updateSite(site.id, {
        name,
        domains: list,
        port: 0,
        cert: httpsOn.val ? "auto" : "off",
        mode: "static",
        upstreams: [],
        proxies: proxyList,
        redir_https: !!httpsOn.val,
      });
      const savedVars = await api.saveVars(site.id, vars);
      Object.assign(site, result);
      site.vars = savedVars.vars || {};
      siteName.val = result.name || name;
      domainsText.val = (result.domains || []).join("\n");
      httpsOn.val = certModeOf(result) !== "off";
      proxies.val = proxyRowsOf(result);
      varsPane.update(site.vars);
      if (!quiet) notify("已保存", "success");
      await onUpdated?.();
      await onConfigSynced?.();
      return result;
    } finally {
      busy.val = false;
    }
  };

  const element = div(
    { class: "ssl-pane domains-ssl-pane settings-pane" },
    div(
      { class: "workspace-toolbar" },
      span("配置"),
      action("保存", () => save(), {
        glyph: "save",
        onError,
        disabled: () => busy.val,
      }),
    ),
    label(
      { class: "field site-name-field" },
      span({ class: "field-label" }, "站名"),
      nameInput,
      span({ class: "field-hint" }, "只改主控配置包；点部署后才会到节点。"),
    ),
    div(
      { class: "domain-top" },
      label(
        { class: "field domain-field" },
        span({ class: "field-label" }, "域名"),
        domainBox,
      ),
      div(
        { class: "domain-side" },
        div(
          { class: "dns-actions" },
          action("检查解析", refreshDNS, {
            onError,
            disabled: () => dnsBusy.val || busy.val,
          }),
          span({ class: "pane-hint" }, () => {
            if (dnsBusy.val) return "检查中…";
            const d = dnsInfo.val;
            if (!d) return "";
            if (d.ok) return `通过 ${d.node_ip || ""}`;
            const bad = (d.domains || []).filter((x) => !x.ok && !x.skipped);
            if (!bad.length) return d.summary || "未通过";
            return `未通过：${bad.map((x) => x.host).join(", ")}`;
          }),
        ),
        label(
          { class: "checkbox-field" },
          input({
            type: "checkbox",
            checked: () => httpsOn.val,
            onchange: (e) => {
              httpsOn.val = e.target.checked;
            },
          }),
          span("SSL"),
        ),
      ),
    ),
    div(
      { class: "dns-box" },
      () => {
        const d = dnsInfo.val;
        if (!d?.domains?.length) return null;
        return ul(
          { class: "dns-list" },
          ...d.domains.map((row) =>
            li(
              {
                class: row.ok || row.skipped ? "dns-ok" : "dns-bad",
              },
              dnsRowText(row, d.node_ip),
            ),
          ),
        );
      },
    ),
    div(
      { class: "proxy-box" },
      div(
        { class: "vars-head" },
        span("反代"),
        action(
          "添加",
          () => {
            proxies.val = [
              ...proxies.val,
              { path: "/api", upstream: "127.0.0.1:8080" },
            ];
          },
          { glyph: "plus", kind: "quiet", onError },
        ),
      ),
      () =>
        proxies.val.length
          ? table(
              { class: "vars-table proxy-table" },
              tbody(
                ...proxies.val.map((row, index) =>
                  tr(
                    td(
                      input({
                        value: row.path,
                        placeholder: "/api",
                        "aria-label": "路径",
                        oninput: (e) => {
                          row.path = e.target.value;
                        },
                      }),
                    ),
                    td(
                      input({
                        value: row.upstream,
                        placeholder: "127.0.0.1:8080",
                        "aria-label": "上游",
                        oninput: (e) => {
                          row.upstream = e.target.value;
                        },
                      }),
                    ),
                    td(
                      button(
                        {
                          type: "button",
                          class: "icon-only",
                          title: "删除",
                          onclick: () => {
                            proxies.val = proxies.val.filter(
                              (_, i) => i !== index,
                            );
                          },
                        },
                        icon("failed"),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null,
    ),
    p({ class: "form-error", role: "status" }, () => status.val),
    varsPane.element,
  );

  return {
    element,
    update(value) {
      info.val = value || null;
    },
    updateVars: varsPane.update,
    syncSite(next) {
      if (!next) return;
      if (next.name != null) siteName.val = next.name;
      domainsText.val = (next.domains || []).join("\n");
      httpsOn.val = certModeOf(next) !== "off";
      proxies.val = proxyRowsOf(next);
      if (next.vars) varsPane.update(next.vars);
    },
    focusName() {
      queueMicrotask(() => {
        nameInput.focus();
        nameInput.select();
      });
    },
  };
}
