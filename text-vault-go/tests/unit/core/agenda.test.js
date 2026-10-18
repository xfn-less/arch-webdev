import assert from "node:assert/strict";
import test from "node:test";

import {buildAgenda} from "../../../web/js/core/agenda.js";

test("agenda keeps only each entry's nearest reminder inside seven days", () => {
  const entries = [
    entry("a", "去年记录 @1-2", "2025-12-30T12:00:00"),
    entry("b", "每月记录 @12-31 和 @9", "2026-09-08T10:00:00"),
    entry("c", "过期固定日期 @2026-9-7，改看 @9-10", "2026-09-08T11:00:00"),
    entry("d", "七天之外 @2026-9-20", "2026-09-08T12:00:00"),
  ];

  const agenda = buildAgenda(entries, new Date(2026, 8, 8, 12));

  assert.deepEqual(agenda.days.map(day => day.date), ["2025-12-30", "2026-09-08"]);
  assert.deepEqual(agenda.days.map(day => day.entries.map(item => item.id)), [["a"], ["b", "c", "d"]]);
  assert.deepEqual(agenda.reminders.map(item => [item.date, item.entry.id]), [
    ["2026-09-09", "b"],
    ["2026-09-10", "c"],
  ]);
});

test("agenda ignores impossible and embedded date markers", () => {
  const agenda = buildAgenda([
    entry("a", "@2-30 x@10-23 @13-1 @0 @2026-2-30", "2026-09-08T10:00:00"),
  ], new Date(2026, 8, 8, 12));

  assert.deepEqual(agenda.reminders, []);
});

function entry(id, text, createdAt) {
  return {schemaVersion: 1, id, kind: "entry", text, properties: {}, createdAt, updatedAt: createdAt, revision: 1};
}
