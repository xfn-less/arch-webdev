// The query engine turns declarative query data into object selections.
// It is deliberately pure: browser state, persistence, and presentation are
// supplied by callers and remain outside this module.
export function runQuery(spec, objects) {
  validateQuery(spec);
  if (!Array.isArray(objects)) throw new TypeError("objects must be an array");

  // Spaces combine ordinary full-text terms. Keeping this rule here makes
  // every future view share the same AND-search meaning.
  const needles = spec.text.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return objects
    .filter(object => object.kind === "entry" && needles.every(needle => object.text.toLocaleLowerCase().includes(needle)))
    .toSorted((left, right) => left[spec.orderBy].localeCompare(right[spec.orderBy]) || left.id.localeCompare(right.id));
}

function validateQuery(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new TypeError("invalid query");
  if (spec.type !== "full-text") throw new TypeError("unsupported query type");
  if (typeof spec.text !== "string") throw new TypeError("invalid query text");
  if (!["createdAt", "updatedAt"].includes(spec.orderBy)) throw new TypeError("unsupported query order");
  if (spec.direction !== "asc") throw new TypeError("unsupported query direction");
}
