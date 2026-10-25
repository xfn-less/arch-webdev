import van from "../vendor/van-1.6.1.js";
import { api } from "./api.js";
import { action, field, icon } from "./ui.js";
const { button, div, form, input, p, span, table, tbody, td, tr } = van.tags;

const nameOk = (k) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k);

export function createVarsPane(site, { onError, notify, onUpdated }) {
  const rows = van.state(
    Object.entries(site.vars || {}).map(([key, value]) => ({ key, value })),
  );
  const busy = van.state(false);
  const status = van.state(
    "文件里写 {{变量名}}，部署打包时替换；主控原件保留占位符。",
  );

  const addRow = () => {
    rows.val = [...rows.val, { key: "", value: "" }];
  };
  const removeRow = (index) => {
    rows.val = rows.val.filter((_, i) => i !== index);
  };

  const element = div(
    { class: "vars-pane" },
    div(
      { class: "workspace-toolbar" },
      div(
        { class: "actions" },
        span({ class: "inline-note" }, icon("config"), span("链接变量")),
        action("添加变量", addRow, { glyph: "plus", kind: "quiet", onError }),
      ),
      action(
        "保存变量",
        async () => {
          if (busy.val) return;
          const vars = {};
          for (const row of rows.val) {
            const key = row.key.trim();
            if (!key && !row.value.trim()) continue;
            if (!nameOk(key)) {
              status.val = `变量名无效：${key || "(空)"}`;
              return;
            }
            if (key in vars) {
              status.val = `变量名重复：${key}`;
              return;
            }
            vars[key] = row.value;
          }
          busy.val = true;
          status.val = "正在保存…";
          try {
            const result = await api.saveVars(site.id, vars);
            site.vars = result.vars || {};
            rows.val = Object.entries(site.vars).map(([key, value]) => ({
              key,
              value,
            }));
            status.val = "已保存；下次部署时替换。";
            notify("站点变量已保存", "success");
            await onUpdated?.();
          } catch (error) {
            status.val = error.message;
            onError(error);
          } finally {
            busy.val = false;
          }
        },
        {
          glyph: "save",
          onError,
          disabled: () => busy.val,
        },
      ),
    ),
    form(
      {
        onsubmit: (event) => event.preventDefault(),
        class: "vars-form",
      },
      () =>
        rows.val.length
          ? table(
              { class: "vars-table" },
              tbody(
                ...rows.val.map((row, index) =>
                  tr(
                    td(
                      input({
                        value: row.key,
                        placeholder: "DOWNLOAD_URL",
                        "aria-label": "变量名",
                        oninput: (e) => {
                          row.key = e.target.value;
                        },
                      }),
                    ),
                    td(
                      input({
                        value: row.value,
                        placeholder: "https://…",
                        "aria-label": "变量值",
                        oninput: (e) => {
                          row.value = e.target.value;
                        },
                      }),
                    ),
                    td(
                      button({
                        type: "button",
                        class: "icon-only",
                        title: "删除变量",
                        "aria-label": "删除变量",
                        onclick: () => removeRow(index),
                      }, icon("failed")),
                    ),
                  ),
                ),
              ),
            )
          : p({ class: "pane-hint" }, "还没有变量。可添加 DOWNLOAD_URL、TG_LINK 等。"),
      p({ class: "pane-hint", role: "status" }, () => status.val),
      p(
        { class: "pane-hint" },
        "只处理文本文件；APK/图片等二进制不会替换。占位符格式：{{DOWNLOAD_URL}}",
      ),
    ),
  );

  return {
    element,
    update(value) {
      site.vars = value || {};
      rows.val = Object.entries(site.vars).map(([key, value]) => ({ key, value }));
    },
  };
}
