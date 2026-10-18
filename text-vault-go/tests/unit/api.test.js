import test from "node:test";
import assert from "node:assert/strict";
import {createAPI} from "../../web/js/api.js";

test("setup and login send only a derived credential to authentication endpoints", async () => {
  const requests = [];
  const api = createAPI(async (path, options) => {
    requests.push({path, body: JSON.parse(options.body)});
    return new Response(JSON.stringify({csrfToken: "csrf"}), {status: 200, headers: {"Content-Type": "application/json"}});
  });

  await api.setup({schemaVersion: 1}, "derived-credential");
  await api.login("derived-credential");
  await api.rekey({schemaVersion: 1}, "new-derived-credential");

  assert.deepEqual(requests, [
    {path: "/api/setup", body: {header: {schemaVersion: 1}, credential: "derived-credential"}},
    {path: "/api/login", body: {credential: "derived-credential"}},
    {path: "/api/rekey", body: {header: {schemaVersion: 1}, credential: "new-derived-credential"}},
  ]);
});

test("changes encodes the generation cursor", async () => {
  const paths = [];
  const api = createAPI(async path => {
    paths.push(path);
    return new Response(JSON.stringify({generation: 12, objects: {}}), {status: 200, headers: {"Content-Type": "application/json"}});
  });

  assert.deepEqual(await api.changes(7), {generation: 12, objects: {}});
  assert.deepEqual(paths, ["/api/changes?after=7"]);
});

test("csrf token can be handed to another in-memory API client", async () => {
  const api = createAPI(async () => new Response(null, {status: 204}));
  assert.equal(api.csrfToken(), "");
  api.setCSRFToken("shared-token");
  assert.equal(api.csrfToken(), "shared-token");
  await api.commit({baseGeneration: 0, objects: []});
});

test("rekey adopts the fresh server session token", async () => {
  const api = createAPI(async path => new Response(JSON.stringify({csrfToken: path === "/api/rekey" ? "rotated" : "initial"}), {
    status: 200, headers: {"Content-Type": "application/json"},
  }));
  await api.login("credential");
  await api.rekey({schemaVersion: 1}, "new-credential");
  assert.equal(api.csrfToken(), "rotated");
});
