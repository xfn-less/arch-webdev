import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as batch from '../web/js/core/batch-replace.js';
import {createRepository} from '../web/js/repository.js';
import {createEntry} from '../web/js/model.js';
test('commands support literal text, deletion, quoted arrows and reject empty sources', () => {
  assert.deepEqual(batch.parseReplacement('AAA -> BBB'),{from:'AAA',to:'BBB'});
  assert.deepEqual(batch.parseReplacement('AAA ->'),{from:'AAA',to:''});
  assert.equal(batch.parseReplacement('"AAA -> BBB"'),null);
  assert.deepEqual(batch.parseReplacement('"a -> b" -> "$&"'),{from:'a -> b',to:'$&'});
  assert.throws(()=>batch.parseReplacement(' -> BBB'),/查找/);
});
test('preview does not write; replacement is literal, full-text; stale previews reject all changes', () => {
  const a={...createEntry(),text:'AAA AAA',properties:{},revision:1};
  const b={...createEntry({existingIDs:[a.id]}),text:'AAA',revision:1};
  const repo=createRepository([a,b]);
  const plan=batch.previewReplacement(repo.values(),{from:'AAA',to:'$&'});
  assert.equal(repo.hasPendingChanges(),false);
  assert.deepEqual(plan.map(p=>p.text),['$& $&','$&']);
  repo.upsert({...b,text:'changed'});
  assert.throws(()=>batch.applyReplacement(repo,plan),/变化/);
  assert.equal(repo.get(a.id).text,'AAA AAA');
  batch.applyReplacement(repo,batch.previewReplacement(repo.values(),{from:'AAA',to:''}));
  assert.ok(repo.get(a.id).deletedAt);
  assert.deepEqual(repo.get(a.id).properties,{});
  assert.equal(repo.get(b.id).text,'changed');
  assert.deepEqual(batch.previewReplacement(repo.values(),{from:'AAA',to:'BBB'}),[]);
});

test('typing stays a search until the unquoted arrow is complete; spaces are optional', () => {
  for (const query of ['111', '111-', '111 -', '"111->222"']) assert.equal(batch.parseReplacement(query), null);
  assert.deepEqual(batch.parseReplacement('111->222'), {from:'111', to:'222'});
  assert.deepEqual(batch.parseReplacement('111->'), {from:'111', to:''});
  assert.deepEqual(batch.parseReplacement('111 ->222'), {from:'111', to:'222'});
  assert.deepEqual(batch.parseReplacement('"111->222"->333'), {from:'111->222', to:'333'});
});
