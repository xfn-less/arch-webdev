import test from "node:test";
import assert from "node:assert/strict";
import {fileTree, formatBytes, listDir} from "../../web/js/files.js";

test("file tree groups nested folders and filters by full relative path", () => {
  const files = [{path: "index.html", size: 20}, {path: "assets/js/app.js", size: 50}, {path: "assets/style.css", size: 10}, {path: "__proto__/safe.txt", size: 1}];
  const tree = fileTree(files);
  assert.deepEqual(tree.files.map(f => f.name), ["index.html"]);
  assert.equal(tree.folders.find(d => d.name === "assets").folders[0].files[0].path, "assets/js/app.js");
  assert.equal(tree.folders.find(d => d.name === "__proto__").files[0].name, "safe.txt");
  assert.equal(fileTree(files, "APP.JS").folders[0].folders[0].files[0].name, "app.js");
  assert.deepEqual(fileTree(files, "missing").files, []);
  assert.equal(files[0].path, "index.html");
  const withDirs = fileTree([{path: "empty/dir", size: 0, dir: true}, {path: "empty/dir/a.txt", size: 1}]);
  assert.equal(withDirs.folders[0].name, "empty");
  assert.equal(withDirs.folders[0].folders[0].name, "dir");
  assert.equal(withDirs.folders[0].folders[0].files[0].name, "a.txt");
});
test("human-readable file sizes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1048576), "1.0 MB");
});

test("listDir shows one folder level like a file manager", () => {
  const files = [
    {path: "index.html", size: 20},
    {path: "site", size: 0, dir: true},
    {path: "site/index.html", size: 10},
    {path: "site/web/app.js", size: 5},
    {path: "dist/a.txt", size: 1},
  ];
  const root = listDir(files, "");
  assert.deepEqual(root.folders.map((f) => f.name).sort(), ["dist", "site"]);
  assert.deepEqual(root.files.map((f) => f.name), ["index.html"]);
  const site = listDir(files, "site");
  assert.deepEqual(site.folders.map((f) => f.name), ["web"]);
  assert.deepEqual(site.files.map((f) => f.name), ["index.html"]);
  const web = listDir(files, "site/web");
  assert.deepEqual(web.folders, []);
  assert.deepEqual(web.files.map((f) => f.path), ["site/web/app.js"]);
});
