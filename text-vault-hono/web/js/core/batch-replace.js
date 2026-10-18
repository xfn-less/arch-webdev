// Plain, case-sensitive replacement. Quoting the whole query searches an arrow literally.
export function parseReplacement(query) {
  let quoted = false;
  let split = -1;
  for (let i = 0; i < query.length; i++) {
    if (quoted && query[i] === '\\') { i++; continue; }
    if (query[i] === '"') quoted = !quoted;
    if (!quoted && query.slice(i, i + 2) === '->') {
      if (split !== -1) throw new Error('一次只支持一个 ->；文字中的箭头请放在双引号内');
      split = i; i++;
    }
  }
  if (split === -1) return null;
  const decode = value => {
    value = value.trim();
    if (!value.startsWith('"')) return value;
    try { const parsed = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch {}
    throw new Error('双引号文字格式错误');
  };
  const from = decode(query.slice(0, split));
  const to = decode(query.slice(split + 2));
  if (!from) throw new Error('请填写要查找替换的文字');
  return {from, to};
}

export function previewReplacement(objects, {from, to}) {
  if (!from || from === to) return [];
  return objects.filter(entry => entry.kind === 'entry' && !entry.deletedAt && entry.text.includes(from))
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map(entry => ({id: entry.id, original: entry.text, revision: entry.revision, text: entry.text.replaceAll(from, () => to)}));
}

export function applyReplacement(repository, preview) {
  // Validate every row before changing any row; never apply an obsolete preview.
  for (const item of preview) {
    const entry = repository.get(item.id);
    if (!entry || entry.deletedAt || entry.text !== item.original || entry.revision !== item.revision) throw new Error('条目已有变化，已更新预览，请核对后再确认');
  }
  for (const item of preview) {
    if (!item.text.trim()) repository.remove(item.id);
    else repository.updateEntryText(item.id, item.text);
  }
}
