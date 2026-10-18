export async function loadEntries() {
  const response = await fetch("/api/entries");
  if (!response.ok) throw new Error("无法加载条目");
  return response.json();
}

export async function saveEntry(entry) {
  const response = await fetch(`/api/entries/${encodeURIComponent(entry.id)}`, {
    method: "PUT",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(entry),
  });
  if (!response.ok) throw new Error("保存失败");
}

export async function deleteEntry(id) {
  const response = await fetch(`/api/entries/${encodeURIComponent(id)}`, {method: "DELETE"});
  if (!response.ok) throw new Error("删除失败");
}
