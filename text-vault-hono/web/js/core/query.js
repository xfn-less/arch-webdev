// The query engine turns declarative query data into object selections.
// It is deliberately pure: browser state, persistence, and presentation are
// supplied by callers and remain outside this module.
export function runQuery(spec, objects) {
  validateQuery(spec);
  if (!Array.isArray(objects)) throw new TypeError("objects must be an array");

  // ^"literal text"$ is one whole-line query, not a regular expression.
  const anchored = /^\^("(?:\\.|[^"\\])*")\$$/.exec(spec.text.trim());
  let exactLine = null;
  if (anchored) {
    try { exactLine = JSON.parse(anchored[1]).trim().toLocaleLowerCase(); }
    catch { throw new Error('整行搜索的引号或转义格式错误'); }
  }
  const groups = anchored ? [] : parseSearch(spec.text);
  return objects
    .filter(object => {
      if (object.kind !== "entry" || object.deletedAt) return false;
      if (exactLine !== null) return object.text.split(/\r?\n/).some(line => line.trim().toLocaleLowerCase() === exactLine);
      if (!groups.length) return true;
      // Search the same complete text that is displayed and edited.
      const text = object.text.toLocaleLowerCase();
      return groups.some(terms => terms.every(term => text.includes(term)));
    })
    .toSorted((left, right) => left[spec.orderBy].localeCompare(right[spec.orderBy]) || left.id.localeCompare(right.id));
}

function validateQuery(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new TypeError("invalid query");
  if (spec.type !== "full-text") throw new TypeError("unsupported query type");
  if (typeof spec.text !== "string") throw new TypeError("invalid query text");
  if (!["createdAt", "updatedAt"].includes(spec.orderBy)) throw new TypeError("unsupported query order");
  if (spec.direction !== "asc") throw new TypeError("unsupported query direction");
}

// A query is OR-separated groups of AND terms. No AST, eval, or query framework.
export function parseSearch(query) {
  if (!query.trim()) return [];
  const groups = [[]];
  let needsTerm = true;
  const pattern = /"((?:\\.|[^"\\])*)"|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const quoted = match[1] !== undefined;
    const token = quoted ? match[1].replace(/\\(["\\])/g, '$1') : match[2];
    if (!quoted && token.startsWith('"')) throw new Error('搜索短语缺少结束的双引号');
    if (quoted && query[match.index + match[0].length] && !/\s/.test(query[match.index + match[0].length])) throw new Error('搜索词之间请用空格分隔');
    if (!quoted && (token === 'OR' || token === 'AND')) {
      if (needsTerm) throw new Error(`${token} 前面缺少搜索词`);
      if (token === 'OR') groups.push([]);
      needsTerm = true;
    } else {
      if (!token) throw new Error('双引号内请填写搜索词');
      groups.at(-1).push(token.toLocaleLowerCase());
      needsTerm = false;
    }
  }
  if (needsTerm) throw new Error('AND / OR 后面缺少搜索词');
  return groups;
}
