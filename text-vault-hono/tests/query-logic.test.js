import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSearch, runQuery} from '../web/js/core/query.js';
const entries=['上海 服务器','上海 联系人','香港','NEW YORK 服务器','new fast york','OR manual'].map((text,i)=>({id:String(i),kind:'entry',text,properties:{},createdAt:`2026-01-0${i+1}`}));
const search=text=>runQuery({type:'full-text',text,orderBy:'createdAt',direction:'asc'},entries).map(e=>e.id);
test('AND precedence, OR union, quoted phrases and literal operators',()=>{
 assert.deepEqual(search('上海 服务器 OR 香港'),['0','2']);
 assert.deepEqual(search('上海 AND 服务器'),['0']);
 assert.deepEqual(search('"new york"'),['3']);
 assert.deepEqual(search('"OR"'),['3','4','5']);
 assert.deepEqual(search('上海 OR 上海'),['0','1']);
 assert.deepEqual(search(''),entries.map(e=>e.id));
 assert.deepEqual(parseSearch('"a \\"quote\\""'),[['a "quote"']]);
});
test('unfinished expressions fail clearly instead of showing all entries',()=>{
 for(const query of ['OR 上海','上海 OR','上海 AND OR 香港','"上海','""','"上海"香港']) assert.throws(()=>parseSearch(query));
});

test('anchored quoted text matches a whole trimmed line, without treating punctuation as regex',()=>{
 const texts=['tgId: @vv333','tgId: @vv333bb','提到 tgId: @vv333','tgId: @vv333 后缀','正文\r\n  tgId: @VV333 \t\r\n结尾','tgId: @vv.333','tgId: @vvX333','正文\ntgId: @vv333'];
 const objects=texts.map((text,i)=>({...entries[0],id:String(i),text}));
 const find=text=>runQuery({type:'full-text',text,orderBy:'createdAt',direction:'asc'},objects).map(e=>e.id);
 assert.deepEqual(find('^"tgId: @vv333"$'),['0','4','7']);
 assert.deepEqual(find('^"tgId: @vv.333"$'),['5']);
 assert.deepEqual(find('"tgId: @vv333"'),['0','1','2','3','4','7']);
});
