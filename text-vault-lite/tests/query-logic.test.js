import {test} from "node:test";
import assert from "node:assert/strict";
import {runQuery} from "../web/js/core/query.js";

const entries = ["上海 服务器", "上海 联系人", "香港"].map((text, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i}`,
  text,
  createdAt: `2026-01-0${i + 1}`,
  updatedAt: `2026-01-0${i + 1}`,
}));

test("substring search", () => {
  assert.deepEqual(runQuery("上海", entries).map(e => e.id), [entries[0].id, entries[1].id]);
  assert.deepEqual(runQuery("", entries).map(e => e.id), entries.map(e => e.id));
});
