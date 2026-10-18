import {test} from 'node:test';
import assert from 'node:assert/strict';
import {textLinks} from '../web/js/core/text-links.js';

test('search links and external URLs preserve the original plain text', () => {
  const text = '去 [[服务器 上海 OR 香港]] 看 https://example.com/a?q=1&b=2。还有 (https://example.com/a(b))';
  const parts = textLinks(text);
  assert.equal(parts.map(part=>part.text).join(''),text);
  assert.equal(parts.find(part=>part.type==='search').query,'服务器 上海 OR 香港');
  assert.deepEqual(parts.filter(part=>part.type==='url').map(part=>part.text),['https://example.com/a?q=1&b=2','https://example.com/a(b)']);
});
test('unsafe schemes and malformed links remain ordinary text', () => {
  const text = 'javascript:alert(1) <img src=x> [[unfinished\n[[ ]]';
  assert.ok(textLinks(text).every(part=>part.type==='text'));
  assert.equal(textLinks(text).map(part=>part.text).join(''),text);
  assert.equal(textLinks('[[https://example.com]]')[0].type,'search');
});

test('www URLs use HTTPS, preserve punctuation, and do not link inside email', () => {
  const text = 'www.tkspcin.com，(www.example.com/a) a@www.example.com';
  const parts = textLinks(text);
  assert.deepEqual(parts.filter(p => p.type === 'url').map(p => p.href), ['https://www.tkspcin.com/', 'https://www.example.com/a']);
  assert.equal(parts.map(p => p.text).join(''), text);
});
