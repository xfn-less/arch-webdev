import test from "node:test";
import assert from "node:assert/strict";
import {sslLabel, siteHref, domainLabel, normalizeDomains} from "../../web/js/ssl.js";

test("left badge is only http or https", () => {
  assert.equal(sslLabel(null, {cert: "auto"}), "https");
  assert.equal(sslLabel({applied: false}, {cert: "auto"}), "https");
  assert.equal(sslLabel(null, {cert: "off"}), "http");
});

test("listen list rows carry their own ports", () => {
  const site = {
    cert: "auto",
    domains: ["1.2.3.4:8888", "*.xxx.com", "test.yyy.cn"],
    ssl: null,
  };
  assert.equal(domainLabel(site, "1.2.3.4:8888"), "1.2.3.4:8888");
  assert.equal(siteHref(site, "1.2.3.4:8888"), "http://1.2.3.4:8888/");
  assert.equal(siteHref(site, "test.yyy.cn"), "http://test.yyy.cn/");
  site.ssl = {applied: true, domains: ["test.yyy.cn"]};
  assert.equal(siteHref(site, "test.yyy.cn"), "https://test.yyy.cn/");
});

test("normalizeDomains forces https off for IP listens", () => {
  const a = normalizeDomains(["1.2.3.4:10000", "180.97.221.31"].join("\n"));
  assert.deepEqual(a.list, ["1.2.3.4:10000", "180.97.221.31"]);
  assert.equal(a.httpsOff, true);
  const b = normalizeDomains("z1.nlpjbz.cn");
  assert.equal(b.httpsOff, false);
});
