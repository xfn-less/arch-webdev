import test from "node:test";
import assert from "node:assert/strict";
import {runQuery} from "../../../web/js/core/query.js";

const early = entry({id: "268t00000", text: "客户A Example.COM", createdAt: "2026-08-29T00:00:00.000Z"});
const later = entry({id: "268t00001", text: "客户B", createdAt: "2026-08-29T02:00:00.000Z"});
const workspace = {schemaVersion: 1, id: "workspace_main_01", kind: "workspace", revision: 1, state: {}};

test("full-text query returns complete entries in stable creation order", () => {
  const objects = [later, workspace, early];
  const before = structuredClone(objects);

  const all = runQuery(fullText(""), objects);
  const matching = runQuery(fullText("EXAMPLE.com"), objects);
  const combined = runQuery(fullText("客户A example"), objects);
  const incomplete = runQuery(fullText("客户B example"), objects);

  assert.deepEqual(all.map(object => object.id), ["268t00000", "268t00001"]);
  assert.equal(matching[0].text, "客户A Example.COM");
  assert.deepEqual(combined.map(object => object.id), ["268t00000"]);
  assert.deepEqual(incomplete, []);
  assert.deepEqual(objects, before);
});

test("equal creation times use the id as a deterministic tie break", () => {
  const sameTime = {...early, id: "268t00002"};
  assert.deepEqual(runQuery(fullText(""), [sameTime, early]).map(object => object.id), ["268t00000", "268t00002"]);
});

test("updated order keeps the most recently changed entry last", () => {
  const recentlyChanged = {...early, updatedAt: "2026-08-30T00:00:00.000Z"};
  const result = runQuery({...fullText(""), orderBy: "updatedAt"}, [recentlyChanged, later]);
  assert.deepEqual(result.map(object => object.id), ["268t00001", "268t00000"]);
});

test("unsupported query declarations fail explicitly", () => {
  assert.throws(() => runQuery({...fullText(""), type: "map"}, []), /unsupported query type/);
  assert.throws(() => runQuery({...fullText(""), orderBy: "title"}, []), /unsupported query order/);
  assert.throws(() => runQuery({...fullText(""), direction: "desc"}, []), /unsupported query direction/);
  assert.throws(() => runQuery({...fullText(""), text: 42}, []), /invalid query text/);
});

function fullText(text) {
  return {type: "full-text", text, orderBy: "createdAt", direction: "asc"};
}

function entry({id, text, createdAt}) {
  return {schemaVersion: 1, id, kind: "entry", text, properties: {}, createdAt, updatedAt: createdAt, revision: 1};
}
