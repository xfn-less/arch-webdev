import {createAPI} from './api.js';
import {createTabSession} from './tab-session.js';
import {decryptSnapshot} from './load.js';
import {encryptObject} from './crypto.js';
import {createEntry} from './model.js';
import {legacyPropertiesToText} from './legacy-properties.js';
import {prepareTotpImport} from './import-totp.js';

const fileInput = document.querySelector('#file');
const status = document.querySelector('#status');
const sessions = createTabSession({timeoutMs: 2000});
let busy = false;
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file || busy) return;
  busy = true; fileInput.disabled = true;
  status.textContent = '正在校验并加密导入…';
  try {
    const source = await file.text();
    prepareTotpImport(source, []); // Reject the whole file before any writes.
    const session = await sessions.request();
    if (!session) throw new Error('请先在同一浏览器打开并解锁 Text Vault，再重新选择文件。');
    const api = createAPI(); api.setCSRFToken(session.csrfToken);
    const snapshot = await api.snapshot();
    const loaded = await decryptSnapshot(session.key, snapshot);
    if (loaded.failures.length) throw new Error('已有条目无法完整解密，未执行导入。');
    const plan = prepareTotpImport(source, loaded.objects.map(legacyPropertiesToText));
    const ids = Object.keys(snapshot.manifest.objects ?? {});
    const entries = plan.entries.map(text => {
      const entry = {...createEntry({existingIDs: ids}), text, revision: 1};
      ids.push(entry.id); return entry;
    });
    if (entries.length) {
      const objects = await Promise.all(entries.map(async entry => {
        const metadata = {id: entry.id, kind: entry.kind, revision: entry.revision};
        return {...metadata, envelope: await encryptObject(session.key, metadata, entry)};
      }));
      await api.commit({baseGeneration: snapshot.manifest.generation, objects});
      const check = await decryptSnapshot(session.key, await api.snapshot());
      if (!entries.every(entry => check.objects.some(saved => saved.id === entry.id && saved.text === entry.text))) throw new Error('保存结果未能完整核对，请重新选择文件重试；已有密钥会自动跳过。');
    }
    status.textContent = `导入完成：新增 ${entries.length} 条，跳过重复 ${plan.skipped} 条。`;
  } catch (error) {
    // Do not surface crypto/URL exceptions which might include provisioning data.
    status.textContent = error.status === 409 ? '保存时数据已变化，请重新选择文件重试；已有密钥会自动跳过。'
      : error.status === 401 ? '登录已过期，请重新解锁 Text Vault 后再选择文件。'
      : error instanceof TypeError || error instanceof DOMException ? '读取或保存失败，请检查连接后重试。'
      : error.message || '导入失败，请重试。';
  } finally { busy = false; fileInput.disabled = false; fileInput.value = ''; }
});
window.addEventListener('beforeunload', event => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => sessions.close());
