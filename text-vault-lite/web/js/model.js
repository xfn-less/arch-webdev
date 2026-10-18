export function createEntry({id, now = new Date().toISOString()} = {}) {
  return {
    id: id ?? crypto.randomUUID(),
    text: "",
    createdAt: now,
    updatedAt: now,
  };
}

export function asEntry(value) {
  if (!value || typeof value.id !== "string" || typeof value.text !== "string" ||
      typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
    throw new TypeError("invalid entry");
  }
  return {
    id: value.id,
    text: value.text,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    deletedAt: value.deletedAt ?? undefined,
  };
}
