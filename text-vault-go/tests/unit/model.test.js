import test from "node:test";
import assert from "node:assert/strict";
import {createEntry, formatMemoTime, newMemoID, nextMemoID, validateObject} from "../../web/js/model.js";

test("createEntry returns a schema-versioned untitled text object", () => {
  const entry = createEntry({id: "268t00000", now: "2026-08-29T00:00:00.000Z"});
  assert.deepEqual(entry, {
    schemaVersion: 1,
    id: "268t00000",
    kind: "entry",
    text: "",
    properties: {},
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    revision: 0,
  });
  assert.equal(validateObject(entry), entry);
});

test("memo ids use time and increment inside the same minute", () => {
  const now = new Date(2026, 8, 6, 13, 7);
  assert.equal(newMemoID([], now), "2696d0700");
  assert.equal(newMemoID(["2696d0700"], now), "2696d0701");
  assert.equal(newMemoID(["2696d0700", "2696d0701"], new Date(2026, 8, 6, 13, 8)), "2696d0800");
});

test("memo id formats its embedded local minute", () => {
  assert.equal(formatMemoTime("2696d070z"), "2026-09-06 13:07");
});

test("next memo id keeps an existing memo's minute prefix", () => {
  assert.equal(nextMemoID(["268t00000"], "268t00000"), "268t00001");
});

test("memo allocation skips IDs reserved by quarantined ciphertext", () => {
  assert.equal(newMemoID(["2696d0700"], new Date(2026, 8, 6, 13, 7)), "2696d0701");
});

test("entry ids must use the nine-character memo format", () => {
  const entry = createEntry({id: "not-a-memo-id", now: "2026-08-29T00:00:00.000Z"});
  assert.throws(() => validateObject(entry), /invalid object/);
});
