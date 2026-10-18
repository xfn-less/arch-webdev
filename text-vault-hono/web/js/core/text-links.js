// Recognize links in plain text; callers create DOM nodes with textContent.
// No HTML or Markdown parser is involved.
export function textLinks(text) {
  const parts = [];
  const pattern = /\[\[([^\]\n]+)\]\]|(?:https?:\/\/|(?<![\w@.])www\.)[^\s<>"'\[\]，。；！？]+/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    parts.push({type: 'text', text: text.slice(cursor, start)});
    if (match[1] !== undefined) {
      const query = match[1].trim();
      parts.push(query ? {type: 'search', text: match[0], query} : {type: 'text', text: match[0]});
      cursor = start + match[0].length;
      continue;
    }
    let url = match[0].replace(/[.,;!?，。；！？]+$/u, '');
    while (url.endsWith(')') && (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)) url = url.slice(0, -1);
    try {
      const parsed = new URL(url.startsWith('www.') ? `https://${url}` : url);
      if (!parsed.hostname) throw new Error('missing host');
      parts.push({type: 'url', text: url, href: parsed.href});
    } catch { parts.push({type: 'text', text: url}); }
    cursor = start + url.length;
  }
  parts.push({type: 'text', text: text.slice(cursor)});
  return parts.filter(part => part.text);
}
