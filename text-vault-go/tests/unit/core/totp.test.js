import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTotpEntry, generateTotp} from '../../../web/js/core/totp.js';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test('plain text stays plain; marked entries use standard defaults', () => {
  assert.equal(parseTotpEntry('ordinary note'), null);
  assert.equal(parseTotpEntry('explaining totp: in prose'), null);
  const entry = parseTotpEntry(`GitHub\ntotp: ${secret.toLowerCase()}`);
  assert.deepEqual(entry.config, {secret, algorithm: 'SHA-1', digits: 6, period: 30});
});
test('otpauth parameters are preserved', () => {
  const entry = parseTotpEntry(`otpauth://totp/Example%3Aalice?secret=${secret}&algorithm=SHA256&digits=8&period=60`);
  assert.equal(entry.config.algorithm, 'SHA-256');
  assert.equal(entry.config.digits, 8);
  assert.equal(entry.config.period, 60);
});
test('invalid marked entries fail visibly without revealing the secret', () => {
  for (const text of ['totp: !bad-secret!', 'totp: A', 'totp: MZ',
    `totp: ${secret}\ntotp: ${secret}`,
    `otpauth://hotp/x?secret=${secret}`,
    ...['digits=7', 'period=0', 'period=30oops', 'algorithm=MD5', 'secret=AAAA'].map(p => `otpauth://totp/x?secret=${secret}&${p}`)]) {
    const entry = parseTotpEntry(text);
    assert.ok(entry.error, text);
    assert.equal(entry.config, undefined);
    assert.ok(!entry.error.includes(secret));
  }
});
// RFC 6238 Appendix B: independent known answers, including post-2038 time.
const vectors = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];
const keys = [
  secret,
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
];
for (const [index, algorithm] of ['SHA-1', 'SHA-256', 'SHA-512'].entries()) {
  test(`RFC 6238 ${algorithm} vectors`, async () => {
    for (const [seconds, ...codes] of vectors) {
      const result = await generateTotp({secret: keys[index], algorithm, digits: 8, period: 30}, seconds * 1000);
      assert.equal(result.code, codes[index]);
    }
  });
}
test('six digits, leading zeroes, period rollover and remaining seconds', async () => {
  const config = parseTotpEntry(`totp: ${secret}`).config;
  assert.deepEqual(await generateTotp(config, 59000), {code: '287082', remaining: 1, counter: 1});
  assert.deepEqual(await generateTotp(config, 60000), {code: '359152', remaining: 30, counter: 2});
  assert.equal((await generateTotp(config, 1111111109000)).code, '081804');
  assert.equal((await generateTotp({...config, period: 60}, 119000)).code, '287082');
  await assert.rejects(() => generateTotp(config, -1));
});
