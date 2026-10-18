import {test} from 'node:test';
import {runQuery} from '../web/js/core/query.js';
import assert from 'node:assert/strict';
import {createRepository} from '../web/js/repository.js';
import {createEntry} from '../web/js/model.js';
import {findTelegramNote, readTelegramNote, updateTelegramNote} from '../web/js/telegram-mapping.js';
const commit = repository => {
  const dirty = repository.captureDirty();
  repository.markCommitted(dirty, Object.fromEntries(dirty.map(item => [item.id, item.baseRevision + 1])));
};

test('searches body and properties; reading never creates; empty save deletes', () => {
  const entry={...createEntry(),text:'tgId: -123\n客户',revision:1};
  const repository=createRepository([entry]);
  assert.equal(readTelegramNote(repository,'-123').id,entry.id);
  assert.equal(readTelegramNote(repository,'-999').id,null);
  assert.equal(repository.values().length,1);
  updateTelegramNote(repository,{tgId:'-123',text:'',expected:{id:entry.id,revision:1}});
  commit(repository);
  assert.equal(readTelegramNote(repository,'-123').id,null);
});
test('stale edits reject; retry after a lost save response is idempotent', () => {
  const repository = createRepository([]);
  const request = {tgId: 'A', text: 'tgId: A\nfirst', expected: {id: null, revision: 0}};
  updateTelegramNote(repository, request); commit(repository);
  updateTelegramNote(repository, request);
  assert.equal(repository.values().length, 1);
  assert.throws(() => updateTelegramNote(repository, {...request, text: 'stale'}), /别处修改/);
  const entry = findTelegramNote(repository, 'A');
  repository.upsert({...entry, properties: {...entry.properties, keep: 123}});commit(repository);
  updateTelegramNote(repository, {tgId: 'A', text: 'tgId: A\nsecond', expected: {id: entry.id, revision: 2}});
  assert.match(repository.get(entry.id).text,/second/);
});
test('duplicate and conflict notes do not silently pick or overwrite an entry', () => {
  const repository = createRepository([]);
  for(let i = 0; i < 2; i++) repository.upsert({...createEntry({existingIDs: repository.knownIDs()}), properties: {tgId: 'A'}});
  assert.throws(() => findTelegramNote(repository, 'A'), /重复或冲突/);
  assert.throws(() => updateTelegramNote(repository, {tgId: 'A', text: 'x', expected: {id: null, revision: 0}}), /重复或冲突/);
});

test('legacy attributes are readable as ordinary labels; editing does not parse a header', () => {
  const old={...createEntry(),text:'正文',properties:{tgId:'客户A',来源:'网页'},revision:1};
  const repository=createRepository([old]);
  assert.equal(readTelegramNote(repository,'客户A').editorText,'tgId: 客户A\n来源: 网页\n\n正文');
  updateTelegramNote(repository,{tgId:'客户A',format:'plain-text',text:'tgId: 客户B\n来源: 手写\n\n正文',expected:{id:old.id,revision:1}});
  commit(repository);
  assert.equal(readTelegramNote(repository,'客户A').id,null);
  assert.equal(readTelegramNote(repository,'客户B').id,old.id);
  assert.deepEqual(repository.get(old.id).properties,{});
});

test('searches the complete literal tgId phrase, not a bare ID or unrelated property', () => {
  const repository=createRepository([]);
  for (const text of ['联系人 @vv333bb','其他: @vv333bb','tgId: 别人\n@vv333bb']) repository.upsert({...createEntry({existingIDs:repository.knownIDs()}),text});
  commit(repository);
  assert.equal(readTelegramNote(repository,'@vv333bb').id,null);
  const entry={...createEntry({existingIDs:repository.knownIDs()}),text:'tgId: @vv333bb\ntgTitle: 收藏\n\n记录',revision:1};
  repository.applyRemote([entry]);
  assert.equal(readTelegramNote(repository,'@vv333bb').id,entry.id);
  assert.equal(readTelegramNote(repository,'vv333bb').id,null);
});

test('new note labels are ordinary body text; existing text and titles are never auto-rewritten', () => {
  const repository=createRepository([]);
  const preview=readTelegramNote(repository,'-111',undefined,'首次群名');
  assert.equal(preview.editorText,'tgId: -111\ntgTitle: 首次群名\n\n');
  assert.equal(repository.values().length,0);
  const id=updateTelegramNote(repository,{tgId:'-111',tgTitle:'首次群名',format:'plain-text',text:preview.editorText+'正文',expected:{id:null,revision:0}});
  commit(repository);
  assert.deepEqual(repository.get(id).properties,{});
  assert.equal(repository.get(id).text,'tgId: -111\ntgTitle: 首次群名\n\n正文');
  const note=readTelegramNote(repository,'-111',undefined,'新群名');
  assert.equal(note.editorText,repository.get(id).text);
  updateTelegramNote(repository,{tgId:'-111',tgTitle:'新群名',format:'plain-text',text:'tgId: -111\n我删掉了标题行',expected:{id,revision:1}});
  commit(repository);
  assert.equal(readTelegramNote(repository,'-111',undefined,'新群名').editorText,'tgId: -111\n我删掉了标题行');
});

test('multiple hits expose exactly the same phrase for web search', () => {
  const repository=createRepository([]);
  for(let i=0;i<2;i++) repository.upsert({...createEntry({existingIDs:repository.knownIDs()}),text:'tgId: @vv333bb\n'+i});
  repository.upsert({...createEntry({existingIDs:repository.knownIDs()}),text:'tgId: @vv333bbextra'});
  assert.throws(()=>findTelegramNote(repository,'@vv333bb'),error=>{
    assert.equal(error.count,2);
    assert.equal(error.query,'^"tgId: @vv333bb"$');
    assert.equal(runQuery({type:'full-text',text:error.query,orderBy:'createdAt',direction:'asc'},repository.values()).length,2);
    return true;
  });
});

test('prefix usernames are separate notes; saving one cannot modify the other',()=>{
 const repository=createRepository();
 for(const text of ['tgId: @vv333\n短名字','tgId: @vv333bb\n长名字','提到 tgId: @vv333','tgId: @vv333 后缀']) repository.upsert({...createEntry({existingIDs:repository.knownIDs()}),text});
 commit(repository);
 const short=readTelegramNote(repository,'@vv333');
 const long=readTelegramNote(repository,'@vv333bb');
 assert.notEqual(short.id,long.id);
 updateTelegramNote(repository,{tgId:'@vv333',text:'tgId: @vv333\n只改短名字',expected:{id:short.id,revision:short.revision}});
 assert.equal(repository.get(long.id).text,'tgId: @vv333bb\n长名字');
});
