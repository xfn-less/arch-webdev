// Read compatibility only: old user properties become ordinary text.
// The converted object is persisted on its next edit, using normal version checks.
export function legacyPropertiesToText(entry) {
  if (entry.kind !== 'entry' || entry.deletedAt) return entry;
  const lines = [];
  const properties = {};
  for (const [key, value] of Object.entries(entry.properties)) {
    if (key === 'conflict' || key === 'telegramMapping') properties[key] = value;
    else lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  if (!lines.length) return entry;
  return {...entry, text: `${lines.join('\n')}\n\n${entry.text}`, properties};
}
