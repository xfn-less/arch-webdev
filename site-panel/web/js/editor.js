// Small adapter around the vendored Ace browser build. No framework or build step.
let loading;
function stylesheet(name) {
  const href = `/vendor/ace/${name}`;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet"; link.href = href;
  document.head.append(link);
}
function loadAce() {
  if (loading) return loading;
  stylesheet("ace.css"); stylesheet("theme-textmate.css");
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/ace/ace.js";
    const timer = setTimeout(() => { script.remove(); reject(new Error("编辑器加载超时，请重试")); }, 15000);
    script.onload = () => {
      clearTimeout(timer);
      const ace = globalThis.ace;
      // Use external CSS; don't weaken the panel's CSP to allow inline styles/eval.
      ace.config.set("useStrictCSP", true);
      ace.config.set("basePath", "/vendor/ace");
      ace.config.set("modePath", "/vendor/ace");
      ace.config.set("loadWorkerFromBlob", false);
      resolve(ace);
    };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error("编辑器加载失败，请刷新后重试")); };
    document.head.append(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}
export function modeForPath(path) {
  const name = path.toLowerCase().split("/").at(-1);
  if (name === "nginx.conf" || name.endsWith(".nginx.conf")) return "nginx";
  const ext = name.split(".").at(-1);
  return ({conf: "nginx", html: "html", htm: "html", xml: "xml", svg: "xml", js: "javascript", mjs: "javascript", cjs: "javascript", css: "css", json: "json", yml: "yaml", yaml: "yaml", sh: "sh", bash: "sh", md: "markdown"})[ext] || "text";
}
export async function createCodeEditor(host, {path, value, readOnly = false, onSave = () => {}, onChange = () => {}}) {
  const ace = await loadAce();
  if (!host.isConnected) throw new Error("编辑器已关闭");
  const editor = ace.edit(host);
  const session = editor.session;
  session.setUseWorker(false); // Highlighting is not validation; no worker/CDN dependency.
  editor.setOptions({fontSize: 14, showPrintMargin: false, tabSize: 2, useSoftTabs: true, wrap: true, readOnly, highlightActiveLine: !readOnly});
  editor.setValue(value, -1);
  const setPath = name => { const mode = modeForPath(name); host.dataset.mode = mode; session.setMode(`ace/mode/${mode}`); };
  setPath(path);
  editor.setOption("textInputAriaLabel", readOnly ? "配置内容（只读）" : "文件内容");
  session.on("change", onChange);
  editor.commands.addCommand({name: "saveToPanel", bindKey: {win: "Ctrl-S", mac: "Command-S"}, exec: () => { if (!readOnly) onSave(); }, readOnly: true});
  const observer = new ResizeObserver(() => editor.resize()); observer.observe(host);
  requestAnimationFrame(() => { if (host.isConnected) { editor.resize(); editor.focus(); } });
  host.dataset.editorReady = "true";
  return {
    getValue: () => editor.getValue(),
    setValue: value => editor.setValue(value, -1),
    focus: () => { editor.resize(); editor.focus(); },
    setPath,
    destroy() { observer.disconnect(); editor.destroy(); session.destroy(); },
  };
}
