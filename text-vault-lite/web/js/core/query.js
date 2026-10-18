export function runQuery(text, objects) {
  const q = String(text ?? "").trim().toLocaleLowerCase();
  return objects
    .filter(entry => !q || entry.text.toLocaleLowerCase().includes(q))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
