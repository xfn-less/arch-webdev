import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runQuery} from '../web/js/core/query.js';
const entries = [
  {id:'a',kind:'entry',text:'telegramTitle: 客户A\nsource: Example.com\n\n服务器 1.2.3.4',properties:{conflict:{of:'hidden-id'}},createdAt:'2026-01-01',updatedAt:'2026-01-03'},
  {id:'b',kind:'entry',text:'客户A 联系人',properties:{},createdAt:'2026-01-02',updatedAt:'2026-01-02'},
];
const search = (text, orderBy='createdAt') => runQuery({type:'full-text',text,orderBy,direction:'asc'},entries).map(entry=>entry.id);
test('search labels and other body text with the same AND rule',()=>{
  assert.deepEqual(search('telegramtitle'),['a']);
  assert.deepEqual(search('客户A'),['a','b']);
  assert.deepEqual(search('客户A 服务器'),['a']);
  assert.deepEqual(search('EXAMPLE.COM'),['a']);
  assert.deepEqual(search('hidden-id'),[]);
  assert.deepEqual(search('不存在'),[]);
});
test('empty search and sorting are unchanged',()=>{
  assert.deepEqual(search(''),['a','b']);
  assert.deepEqual(search('', 'updatedAt'),['b','a']);
});
