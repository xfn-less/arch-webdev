import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRepository} from '../web/js/repository.js';
import {createEntry} from '../web/js/model.js';
import {runQuery} from '../web/js/core/query.js';
import {readTelegramNote,updateTelegramNote} from '../web/js/telegram-mapping.js';
test('legacy attributes become body text once; internal sync metadata stays internal', () => {
 const old={...createEntry(),text:'正文',properties:{tgId:'@vv333bb',tags:['a','b'],count:2,conflict:{of:'source'}}};
 const repo=createRepository([old]);const entry=repo.get(old.id);
 assert.equal(entry.text,'tgId: @vv333bb\ntags: ["a","b"]\ncount: 2\n\n正文');
 assert.deepEqual(entry.properties,{conflict:{of:'source'}});
 assert.equal(repo.hasPendingChanges(),false);
 assert.equal(createRepository(repo.values()).get(old.id).text,entry.text);
 assert.deepEqual(runQuery({type:'full-text',text:'"tgId: @vv333bb"',orderBy:'createdAt',direction:'asc'},repo.values()).map(x=>x.id),[old.id]);
 repo.applyRemote([{...old,text:'远端正文',revision:1}]);assert.match(repo.get(old.id).text,/count: 2\n\n远端正文$/);
});
test('YAML-like text is stored literally, including invalid syntax and duplicate keys', () => {
 const repo=createRepository();
 const text='---\ntgId: @vv333bb\nkey: first\nkey: second\n随便写';
 const id=updateTelegramNote(repo,{tgId:'@vv333bb',format:'plain-text',text,expected:{id:null,revision:0}});
 assert.equal(repo.get(id).text,text);assert.deepEqual(repo.get(id).properties,{});
 const dirty=repo.captureDirty();repo.markCommitted(dirty,{[id]:1});
 assert.equal(readTelegramNote(repo,'@vv333bb').editorText,text);
});
