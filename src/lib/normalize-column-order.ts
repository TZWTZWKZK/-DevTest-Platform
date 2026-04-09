/** 列顺序去重并按 `allKeys` 补全，保证与当前版本列键集合一致 */
export function normalizeColumnOrder<T extends string>(
  order: T[],
  allKeys: readonly T[],
): T[] {
  const allowed = new Set<string>(allKeys);
  const seen = new Set<T>();
  const out: T[] = [];
  for (const k of order) {
    if (allowed.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  for (const k of allKeys) {
    if (!seen.has(k)) out.push(k);
  }
  return out;
}
