import {parseTotpEntry} from './core/totp.js';

export function prepareTotpImport(source, objects) {
  const signature = config => JSON.stringify(config);
  const seen = new Set(objects.filter(entry => entry.kind === 'entry' && !entry.deletedAt)
    .map(entry => parseTotpEntry(entry.text)?.config).filter(Boolean).map(signature));
  const entries = [];
  let skipped = 0;
  for (const [index, raw] of source.split(/\r?\n/).entries()) {
    const uri = raw.trim();
    if (!uri) continue;
    const parsed = parseTotpEntry(uri);
    if (!uri.startsWith('otpauth://totp/') || !parsed?.config) throw new Error(`第 ${index + 1} 行不是有效的 TOTP 配置`);
    let label;
    try {
      const url = new URL(uri);
      label = decodeURIComponent(url.pathname.slice(1)).replace(/[\r\n]+/g, ' ');
      const issuer = (url.searchParams.get('issuer') || '').replace(/[\r\n]+/g, ' ');
      if (issuer && !label.startsWith(issuer)) label = `${issuer}: ${label}`;
    } catch { throw new Error(`第 ${index + 1} 行的账户名称编码无效`); }
    const key = signature(parsed.config);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    entries.push(`#2fa\n${label || '2FA'}\n${uri}`);
  }
  if (!entries.length && !skipped) throw new Error('文件里没有 TOTP 配置');
  return {entries, skipped};
}
