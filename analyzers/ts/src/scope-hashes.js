import ts from 'typescript';

import { scopeOf } from './syntax.js';

/**
 * head 版本中每個具名 function / method 的 canonical hash（二次 review 的人工豁免綁定在這個 hash 上）。
 * subject 的命名與 facts 相同（`Class.method`、function 名稱）；hash 使用 head 的 scope-aware canonical
 * 變數名稱，所以排版、註解與一致的區域變數改名不會改變它。同一個 subject 有多個 node 時合併。
 *
 * @param {ts.SourceFile} sourceFile - head source file。
 * @param {object} hasher - head 的 canonicalizer。
 * @returns {{scopes: Map<string, string>, file: string}} subject → hash，以及整個檔案的 hash。
 */
export function scopeHashes(sourceFile, hasher) {
  const hashes = new Map();
  const visit = (node) => {
    const { subject, scope } = scopeOf(node);
    if (scope === node && subject !== null) hashes.set(subject, [...(hashes.get(subject) ?? []), hasher.hash(node)]);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const scopes = new Map([...hashes].map(([subject, list]) => [subject, list.length === 1 ? list[0] : list.join(':')]));
  return { scopes, file: hasher.hash(sourceFile) };
}

/**
 * 每個 fact 加上 `properties.scope`：所屬 function 的 hash（`kind: function`），不在具名 function 內
 * 或 head 中已不存在時為整個檔案的 hash（`kind: file`）。
 *
 * @param {object[]} facts - facts。
 * @param {ts.SourceFile} sourceFile - head source file。
 * @param {object} hasher - head 的 canonicalizer。
 * @returns {object[]} facts。
 */
export function annotateScopes(facts, sourceFile, hasher) {
  if (facts.length === 0) return facts;
  const { scopes, file } = scopeHashes(sourceFile, hasher);
  return facts.map((fact) => {
    const hash = scopes.get(fact.subject);
    return {
      ...fact,
      properties: {
        ...fact.properties,
        scope: hash === undefined ? { kind: 'file', hash: `ts:${file}` } : { kind: 'function', hash: `ts:${hash}` },
      },
    };
  });
}
