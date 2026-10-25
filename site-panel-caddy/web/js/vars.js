import van from "../vendor/van-1.6.1.js";
import { action, icon } from "./ui.js";
const { button, div, form, input, table, tbody, td, tr, span } = van.tags;

const nameOk = (k) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k);

export function createVarsPane(site, { onError } = {}) {
  const toRows = (vars) => {
    const list = Object.entries(vars || {}).map(([key, value]) => ({ key, value }));
    return list.length ? list : [{ key: "", value: "" }];
  };
  const rows = van.state(toRows(site.vars));

  const addRow = () => {
    rows.val = [...rows.val, { key: "", value: "" }];
  };
  const removeRow = (index) => {
    rows.val = rows.val.filter((_, i) => i !== index);
  };

  const collect = () => {
    const vars = {};
    for (const row of rows.val) {
      const key = row.key.trim();
      if (!key && !row.value.trim()) continue;
      if (!nameOk(key)) throw new Error(`变量名无效：${key || "(空)"}`);
      if (key in vars) throw new Error(`变量名重复：${key}`);
      vars[key] = row.value;
    }
    return vars;
  };

  const element = div(
    { class: "vars-pane vars-embedded" },
    div(
      { class: "vars-head" },
      span("变量"),
      action("添加", addRow, { glyph: "plus", kind: "quiet", onError }),
    ),
    form(
      {
        onsubmit: (event) => event.preventDefault(),
        class: "vars-form",
      },
      () =>
        table(
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
                  button(
                    {
                      type: "button",
                      class: "icon-only",
                      title: "删除变量",
                      "aria-label": "删除变量",
                      onclick: () => removeRow(index),
                    },
                    icon("failed"),
                  ),
                ),
              ),
            ),
          ),
        ),
    ),
  );

  return {
    element,
    collect,
    update(value) {
      site.vars = value || {};
      rows.val = toRows(site.vars);
    },
  };
}
