import van from "../vendor/van-1.6.1.js";
import { api } from "./api.js";
import { field, action, icon } from "./ui.js";
const {
  a,
  button,
  details,
  div,
  form,
  h3,
  input,
  label,
  p,
  span,
  summary,
  table,
  tbody,
  td,
  tr,
  ul,
  li,
} = van.tags;

export function sslLabel(info) {
  if (!info) return "SSL 未申请";
  if (!info.applied) return "SSL 未启用";
  const days = Math.ceil((Date.parse(info.not_after) - Date.now()) / 86400000);
  return days <= 0 ? "SSL 已过期" : `SSL ${days}天`;
}

function isIP(h) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(":");
}

export function domainLabel(site, h) {
  return isIP(h) ? `${h}:${site.port}` : h;
}

export function siteHref(site, h) {
  const https = site.ssl?.applied && site.ssl.domains?.includes(h);
  if (https) return `https://${h}/`;
  if (isIP(h)) return `http://${h}:${site.port}/`;
  return site.port === 80 ? `http://${h}/` : `http://${h}:${site.port}/`;
}

export function createSSLPane(site, { onError, notify, onTask, onUpdated }) {
  const info = van.state(site.ssl || null);
  const domains = van.state([...(site.domains || [])]);
  const port = van.state(site.port || 80);
  const selected = van.state(
    Object.fromEntries(
      (site.domains || []).filter((h) => !isIP(h)).map((h) => [h, true]),
    ),
  );
  const email = input({
    type: "email",
    placeholder: "可选，不填写则没有 CA 邮件通知",
  });
  const agree = input({ type: "checkbox", required: true });
  const staging = input({ type: "checkbox" });
  const busy = van.state(false);
  const status = van.state("");
  const dnsInfo = van.state(null);
  const dnsBusy = van.state(false);
  async function refreshDNS() {
    dnsBusy.val = true;
    try {
      dnsInfo.val = await api.dns(site.id);
    } catch (error) {
      dnsInfo.val = { ok: false, summary: error.message, domains: [] };
      onError(error);
    } finally {
      dnsBusy.val = false;
    }
  }
  const coverageNote = () => {
    const cert = info.val;
    if (!cert?.domains?.length) return "";
    const need = domains.val.filter((h) => !isIP(h));
    const have = new Set(cert.domains || []);
    const missing = need.filter((h) => !have.has(h));
    if (!missing.length) return "证书已覆盖当前域名";
    return "证书未覆盖：" + missing.join(", ") + "（请按当前域名申请）";
  };
  const addDomain = input({
    placeholder: "新域名或 IP",
    "aria-label": "新域名或 IP",
  });

  const saveDomains = async () => {
    const list = domains.val.map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!list.length) throw new Error("至少保留一个域名或 IP");
    const result = await api.updateSite(site.id, {
      name: site.name,
      domains: list,
      port: Number(port.val),
    });
    Object.assign(site, result);
    domains.val = [...(result.domains || [])];
    port.val = result.port;
    const next = {};
    for (const h of domains.val) {
      if (!isIP(h)) next[h] = selected.val[h] !== false;
    }
    selected.val = next;
    notify("已保存", "success");
    await onUpdated?.();
  };

  const element = div(
    { class: "ssl-pane domains-ssl-pane" },
    h3("域名 & SSL"),
    p(
      { class: "pane-hint" },
      "左边列表只显示站名。域名在这里改；IP 显示为 IP:端口，域名一般不带端口。",
    ),
    div(
      { class: "domain-editor" },
      div(
        { class: "workspace-toolbar" },
        span({ class: "inline-note" }, icon("globe"), span("站点域名")),
        div(
          { class: "actions" },
          addDomain,
          action(
            "添加一行",
            () => {
              const h = addDomain.value.trim().toLowerCase();
              if (!h) {
                notify("填写域名或 IP", "warning");
                return;
              }
              if (domains.val.includes(h)) {
                notify("已存在", "warning");
                return;
              }
              domains.val = [...domains.val, h];
              addDomain.value = "";
              if (!isIP(h)) selected.val = { ...selected.val, [h]: true };
            },
            { glyph: "plus", kind: "quiet", onError },
          ),
          action("保存域名", saveDomains, {
            glyph: "save",
            onError,
            disabled: () => busy.val,
          }),
        ),
      ),
      label(
        { class: "field" },
        span({ class: "field-label" }, "HTTP 端口"),
        input({
          type: "number",
          min: 1,
          max: 65535,
          value: () => port.val,
          oninput: (e) => {
            port.val = Number(e.target.value) || 80;
          },
        }),
        span(
          { class: "field-hint" },
          "IP 访问链接会带这个端口；HTTPS 域名走 443。",
        ),
      ),
      () =>
        table(
          { class: "kv-table domain-table" },
          tbody(
            ...domains.val.map((h, index) =>
              tr(
                td(
                  isIP(h)
                    ? span()
                    : label(
                        { class: "checkbox-field" },
                        input({
                          type: "checkbox",
                          checked: !!selected.val[h],
                          onchange: (e) => {
                            selected.val = {
                              ...selected.val,
                              [h]: e.target.checked,
                            };
                          },
                        }),
                        span("申请 SSL"),
                      ),
                ),
                td(
                  a(
                    {
                      href: siteHref(
                        {
                          ...site,
                          domains: domains.val,
                          port: port.val,
                          ssl: info.val,
                        },
                        h,
                      ),
                      target: "_blank",
                      rel: "noopener noreferrer",
                    },
                    domainLabel({ port: port.val }, h),
                  ),
                ),
                td(
                  button(
                    {
                      type: "button",
                      class: "icon-only",
                      title: "删除域名",
                      "aria-label": `删除 ${h}`,
                      onclick: () => {
                        domains.val = domains.val.filter((_, i) => i !== index);
                        const next = { ...selected.val };
                        delete next[h];
                        selected.val = next;
                      },
                    },
                    icon("failed"),
                  ),
                ),
              ),
            ),
          ),
        ),
    ),
    div(
      { class: "dns-box" },
      div(
        { class: "actions" },
        action(
          "检查 DNS",
          refreshDNS,
          { onError, disabled: () => dnsBusy.val },
        ),
        span({ class: "pane-hint" }, () => {
          const d = dnsInfo.val;
          if (dnsBusy.val) return "检查中…";
          if (!d) return "申请前建议对照公网解析";
          return d.ok ? "DNS 对照通过" : d.summary || "DNS 未通过";
        }),
      ),
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
              row.detail || row.host,
            ),
          ),
        );
      },
    ),
    form(
      {
        onsubmit: async (event) => {
          event.preventDefault();
          if (busy.val) return;
          busy.val = true;
          status.val = "正在申请证书…";
          try {
            await saveDomains();
            const picked = domains.val.filter((h) => !isIP(h) && selected.val[h]);
            if (!picked.length) throw new Error("请勾选要申请证书的域名");
            const result = await api.requestSSL(site.id, {
              domains: picked,
              email: email.value.trim(),
              staging: staging.checked,
              agree_terms: agree.checked,
            });
            status.val = staging.checked
              ? "已提交测试申请，不会启用。看站日志。"
              : "已提交申请证书。";
            await onTask(result.task_id);
            await onUpdated?.();
          } catch (error) {
            status.val = error.message;
            onError(error);
          } finally {
            busy.val = false;
          }
        },
      },
      h3("申请 / 续期 SSL"),
      field("联系邮箱", email),
      label(
        { class: "checkbox-field" },
        agree,
        span("同意 "),
        a(
          {
            href: "https://letsencrypt.org/repository/",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Let's Encrypt 服务条款",
        ),
      ),
      details(
        { class: "advanced-block" },
        summary("高级"),
        label(
          { class: "checkbox-field" },
          staging,
          span("测试签发（Let's Encrypt staging，不启用 HTTPS）"),
        ),
      ),
      div(
        { class: "actions" },
        button(
          { type: "submit", class: "btn primary", disabled: () => busy.val },
          () => (busy.val ? "提交中…" : "申请证书"),
        ),
        action(
          "同步证书",
          async () => {
            info.val = await api.syncSSL(site.id);
            await onUpdated?.();
            notify("证书已同步", "success");
          },
          { onError },
        ),
      ),
      p({ class: "form-error", role: "status" }, () => status.val),
    ),
    () =>
      info.val
        ? table(
            { class: "kv-table" },
            tbody(
              ...[
                ["状态", sslLabel(info.val)],
                ["覆盖域名", (info.val.domains || []).join(" ")],
                ["对照", coverageNote()],
                ["到期时间", new Date(info.val.not_after).toLocaleString()],
                ["签发者", info.val.issuer],
                [
                  "节点自动续期",
                  info.val.renew_timer ? "定时器已启用" : "未确认",
                ],
                [
                  "主控备份时间",
                  new Date(info.val.observed_at).toLocaleString(),
                ],
                ["指纹", info.val.fingerprint],
              ].map(([key, value]) => tr(td(key), td(value))),
            ),
          )
        : p("暂无主控证书记录。"),
    p(
      { class: "pane-hint" },
      "只能给具体域名申请。证书路径由面板 SSL 片段维护，业务 conf 需 include panel.inc。",
    ),
  );

  return {
    element,
    update(value) {
      info.val = value || null;
    },
    syncSite(next) {
      if (!next) return;
      domains.val = [...(next.domains || [])];
      port.val = next.port;
      const sel = {};
      for (const h of domains.val) {
        if (!isIP(h)) sel[h] = selected.val[h] !== false;
      }
      selected.val = sel;
    },
  };
}
