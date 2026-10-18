const MEMO_ID_PATTERN = /^[0-9a-z]{9}$/;
const LEGACY_OBJECT_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const KINDS = new Set(["entry", "workspace", "query", "view"]);

export function createEntry({id, existingIDs = [], now = new Date().toISOString()} = {}) {
  id ??= newMemoID(existingIDs, new Date(now));
  return {
    schemaVersion: 1,
    id,
    kind: "entry",
    text: "",
    properties: {},
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
}

export function validateObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 ||
      !validID(value.id, value.kind) || !KINDS.has(value.kind) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new TypeError("invalid object");
  }
  if (value.kind === "entry" && (typeof value.text !== "string" || !isPlainObject(value.properties) ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string")) {
    throw new TypeError("invalid entry");
  }
  return value;
}

// The ID keeps Garden's human-readable, naturally sorted minute prefix. The
// repository supplies all known IDs, so separate views share the same rule.
export function newMemoID(existingIDs, date = new Date()) {
  return allocateMemoID(existingIDs, timePrefix(date));
}

export function nextMemoID(existingIDs, sourceID) {
  if (!MEMO_ID_PATTERN.test(sourceID)) throw new TypeError("invalid memo id");
  return allocateMemoID(existingIDs, sourceID.slice(0, 7));
}

function allocateMemoID(existingIDs, prefix) {
  const ids = new Set([...existingIDs].map(value => typeof value === "string" ? value : value.id));
  for (let sequence = 0; sequence < 36 * 36; sequence += 1) {
    const id = `${prefix}${sequence.toString(36).padStart(2, "0")}`;
    if (!ids.has(id)) return id;
  }
  throw new Error(`too many entries created in one minute: ${prefix}`);
}

export function formatMemoTime(id) {
  if (!MEMO_ID_PATTERN.test(id)) throw new TypeError("invalid memo id");
  const year = 2000 + Number(id.slice(0, 2));
  const month = parseInt(id[2], 36);
  const day = parseInt(id[3], 36);
  const hour = parseInt(id[4], 36);
  return `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${id.slice(5, 7)}`;
}

// Non-entry data/view objects keep opaque random IDs; only human-facing text
// entries use the chronological memo convention.
export function newID(prefix) {
  const random = crypto.getRandomValues(new Uint8Array(16));
  const suffix = Array.from(random, value => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${suffix}`;
}

function timePrefix(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError("invalid memo date");
  return `${pad2(date.getFullYear() % 100)}${(date.getMonth() + 1).toString(36)}${date.getDate().toString(36)}${date.getHours().toString(36)}${pad2(date.getMinutes())}`;
}

function validID(id, kind) {
  if (typeof id !== "string") return false;
  return kind === "entry" ? MEMO_ID_PATTERN.test(id) : LEGACY_OBJECT_ID_PATTERN.test(id);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
