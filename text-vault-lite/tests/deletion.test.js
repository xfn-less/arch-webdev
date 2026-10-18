import {test} from "node:test";
import assert from "node:assert/strict";
import {createRepository} from "../web/js/repository.js";
import {runQuery} from "../web/js/core/query.js";

test("remove hides entry from repository", () => {
  const entry = {
    id: "00000000-0000-4000-8000-000000000001",
    text: "delete me",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  };
  const repo = createRepository([entry]);
  assert.equal(runQuery("", repo.values()).length, 1);
  repo.remove(entry.id);
  assert.equal(runQuery("", repo.values()).length, 0);
});
