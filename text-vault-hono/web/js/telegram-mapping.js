import {runQuery} from './core/query.js';
import {createEntry} from './model.js';

export function findTelegramNote(repository, tgId) {
  if (typeof tgId !== 'string' || !tgId || tgId.length > 1000 || /[\r\n]/.test(tgId)) throw new Error('聊天标识无效');
  const query = `^${JSON.stringify(`tgId: ${tgId}`)}$`;
  const matches = runQuery({type: 'full-text', text: query, orderBy: 'createdAt', direction: 'asc'}, repository.values());
  if (matches.length > 1) throw Object.assign(new Error('这个群的便签有重复或冲突，请在搜索结果中选择'), {query, count: matches.length});
  if (matches.some(entry => entry.properties?.conflict)) throw new Error('这个群的便签有重复或冲突，请先在 Text Vault 处理');
  return matches[0] ?? null;
}

export function readTelegramNote(repository, tgId, entry = findTelegramNote(repository, tgId), tgTitle = '') {
  if (entry?.deletedAt) entry = null;
  if (entry && repository.captureDirty().some(item => item.id === entry.id)) throw new Error('便签在 Text Vault 中尚未保存，请先保存后重试');
  const title = typeof tgTitle === 'string' && tgTitle.length <= 1000 ? tgTitle.replace(/[\r\n]+/g, ' ') : '';
  // Only a new draft gets suggested labels. They are ordinary editable text.
  const editorText = entry ? entry.text : `tgId: ${tgId}\ntgTitle: ${title}\n\n`;
  return {tgId, id: entry?.id ?? null, revision: entry?.revision ?? 0, text: entry?.text ?? '', editorText};
}

export function updateTelegramNote(repository, {tgId, text, expected}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 256 * 1024) throw new Error('便签最多 256 KiB');
  const entry = findTelegramNote(repository, tgId);
  // A timed-out save may already have committed. Retrying the same content is safe.
  if (entry && entry.text === text) return entry.id;
  if (!text.trim() && expected?.id && repository.get(expected.id)?.deletedAt && !entry) return expected.id;
  if (!expected || expected.id !== (entry?.id ?? null) || expected.revision !== (entry?.revision ?? 0)) throw new Error('便签已在别处修改，草稿已保留；请先重新读取后再保存');
  if (!text.trim()) { if (entry) repository.remove(entry.id); return entry?.id ?? null; }
  const next = entry ?? createEntry({existingIDs: repository.knownIDs()});
  repository.upsert({...next, text, updatedAt: new Date().toISOString()});
  return next.id;
}

// An unlocked page handles only per-chat note reads/writes. Keys stay in the vault.
export function installTelegramNotes({repository, saver, sync, target = window}) {
  let queue = Promise.resolve();
  const receive = event => {
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    if (!request || typeof request.id !== 'string' || !['note-read', 'note-write'].includes(request.action)) return;
    queue = queue.then(async () => {
      try {
        await sync.pull();
        let savedID;
        if (request.action === 'note-write') {
          await saver.save();
          savedID = updateTelegramNote(repository, request);
          await saver.save();
        }
        const note = readTelegramNote(repository, request.tgId, savedID ? repository.get(savedID) : undefined, request.tgTitle);
        if (request.action === 'note-write' && !['front-matter', 'plain-text'].includes(request.format) && note.text !== request.text) throw new Error('保存期间内容发生变化，请重新读取核对；草稿已保留');
        // Accept the previous script's format flag too; neither flag parses text.
        if (['front-matter', 'plain-text'].includes(request.format)) note.text = note.editorText;
        target.dispatchEvent(new CustomEvent('text-vault:telegram-response', {detail: JSON.stringify({id: request.id, note})}));
      } catch (error) {
        target.dispatchEvent(new CustomEvent('text-vault:telegram-response', {detail: JSON.stringify({id: request.id, error: error.message || '保存失败', query: error.query, count: error.count})}));
      }
    });
  };
  target.addEventListener('text-vault:telegram-request', receive);
  target.dispatchEvent(new Event('text-vault:telegram-ready'));
  return () => target.removeEventListener('text-vault:telegram-request', receive);
}
