import assert from "node:assert/strict";
import test from "node:test";

import {checkEnvironment} from "../../web/js/environment.js";

const guidance = "Text Vault 需要 HTTPS 或 localhost 才能使用浏览器加密。";

test("accepts a secure context with Web Crypto", () => {
  assert.deepEqual(checkEnvironment({isSecureContext: true, crypto: {subtle: {}}}), {ok: true});
});

test("explains how to fix an insecure context", () => {
  assert.deepEqual(checkEnvironment({isSecureContext: false, crypto: {subtle: {}}}), {
    ok: false,
    message: guidance,
  });
});

test("uses the same actionable message when Web Crypto is unavailable", () => {
  assert.deepEqual(checkEnvironment({isSecureContext: true, crypto: {}}), {
    ok: false,
    message: guidance,
  });
});
