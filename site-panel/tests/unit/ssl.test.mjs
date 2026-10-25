import test from "node:test";
import assert from "node:assert/strict";
import {sslLabel} from "../../web/js/ssl.js";

test("SSL label shows only known certificate/application state", () => {
  assert.equal(sslLabel(null), "SSL 未申请");
  assert.equal(sslLabel({applied: false}), "SSL 未启用");
  assert.equal(sslLabel({applied: true, not_after: new Date(Date.now() - 1000).toISOString()}), "SSL 已过期");
  assert.equal(sslLabel({applied: true, not_after: new Date(Date.now() + 34 * 86400000).toISOString()}), "SSL 34天");
});
