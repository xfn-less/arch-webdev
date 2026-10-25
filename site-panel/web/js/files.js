// Plain data helpers shared by the file tree and tests; no DOM or framework.
export function fileTree(files, query = "") {
  const root = {path: "", name: "", folders: new Map(), files: []};
  const q = query.trim().toLowerCase();
  const ensureFolder = (parts) => {
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join("/");
      if (!parent.folders.has(parts[i])) {
        parent.folders.set(parts[i], {
          path,
          name: parts[i],
          folders: new Map(),
          files: [],
        });
      }
      parent = parent.folders.get(parts[i]);
    }
    return parent;
  };
  for (const file of files) {
    if (q && !file.path.toLowerCase().includes(q)) continue;
    const parts = file.path.split("/");
    if (file.dir) {
      ensureFolder(parts);
      continue;
    }
    const parent = ensureFolder(parts.slice(0, -1));
    parent.files.push({ ...file, name: parts.at(-1) });
  }
  function sorted(node) {
    return {
      ...node,
      folders: [...node.folders.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(sorted),
      files: node.files.sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return sorted(root);
}
export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
export const taskLabels = {
  queued: "等待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  needs_attention: "待核实",
  dismissed: "已忽略",
};
export const stepLabels = {
  prepare: "准备文件",
  install: "安装环境",
  installed: "环境就绪",
  remote_execution: "节点执行",
  submit: "提交任务",
  verify_bundle: "校验文件",
  prepare_files: "准备目录",
  check_nginx: "检查配置",
  switch_files: "切换文件",
  reload_nginx: "加载配置",
  check_http: "检查访问",
  done: "完成",
  awaiting_executor: "等待执行器",
  disable_nginx: "停用配置",
  disable_done: "已停用",
};
