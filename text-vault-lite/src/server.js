import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {serve} from "@hono/node-server";
import {serveStatic} from "@hono/node-server/serve-static";
import {Hono} from "hono";
import {listEntries, openDatabase, softDeleteEntry, upsertEntry} from "./db.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const webRoot = join(root, "web");
const db = openDatabase(process.env.TEXT_VAULT_DB ?? join(root, "data", "text-vault-lite.sqlite"));
const app = new Hono();

app.get("/api/entries", c => c.json(listEntries(db)));

app.put("/api/entries/:id", async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.text !== "string" || typeof body.createdAt !== "string" || typeof body.updatedAt !== "string") {
    return c.json({error: "invalid"}, 400);
  }
  const id = c.req.param("id");
  if (id !== body.id || !/^[A-Za-z0-9_-]{16,80}$/.test(id)) return c.json({error: "invalid"}, 400);
  upsertEntry(db, {
    id,
    text: body.text,
    createdAt: body.createdAt,
    updatedAt: body.updatedAt,
    deletedAt: body.deletedAt ?? null,
  });
  return c.json({ok: true});
});

app.delete("/api/entries/:id", async c => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) return c.json({error: "invalid"}, 400);
  softDeleteEntry(db, id, new Date().toISOString());
  return c.body(null, 204);
});

app.get("/", c => c.redirect("/index.html"));
app.use("*", serveStatic({root: webRoot}));
app.notFound(c => c.text("Not found", 404));

const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? "127.0.0.1";
serve({fetch: app.fetch, port, hostname: host});
console.log(`Text Vault Lite listening on http://${host}:${port}`);
