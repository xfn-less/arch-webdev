import http from "node:http";
import Database from "better-sqlite3";

const PORT = 3000;
const HOST = "127.0.0.1";
const TRACE = process.env.TRACE === "1";

const trace = (label, data) => {
  if (!TRACE) return;
  console.log(`[${label}]`, data);
};

const db = new Database("garden.db", { verbose: console.log });
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  )
`);

const sqlListItems = db.prepare(`
  SELECT id, content, created_at, updated_at, deleted_at
  FROM items
  WHERE deleted_at IS NULL
  ORDER BY created_at DESC
`);

const sqlCreatItems = db.prepare(`
  INSERT INTO items (id, content, created_at, updated_at)
  VALUES (?, ?, ?, ?)
`);

const sendJson = (res, statusCode, data) => {
  trace("RES", { statusCode, data });
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
};

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const data = body ? JSON.parse(body) : {};
        trace("BODY", data);
        resolve(data);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });

const createId = () => `${Date.now().toString(36)}-${crypto.randomUUID()}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  trace("REQ", { method: req.method, path: url.pathname });

  if (req.method === "GET" && url.pathname === "/api/items") {
    trace("ROUTE", "list-items");
    const items = sqlListItems.all();
    trace("DB", { rows: items.length });
    sendJson(res, 200, items);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/items") {
    trace("ROUTE", "create-item");
    try {
      const body = await readJsonBody(req);
      const content = String(body.content || "").trim();

      if (!content) {
        sendJson(res, 400, { error: "content is required" });
        return;
      }

      const now = new Date().toISOString();
      const item = {
        id: createId(),
        content,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      };

      sqlCreatItems.run(item.id, item.content, item.created_at, item.updated_at);
      trace("DB", { created: item.id });
      sendJson(res, 201, item);
    } catch (error) {
      trace("ERR", error.message);
      sendJson(res, 400, { error: error.message });
    }

    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
