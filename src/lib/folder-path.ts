/** 当前目录及其所有子孙目录 id（含自身） */
export function collectDescendantFolderIds<
  T extends { id: string; parentId: string | null },
>(flat: T[], rootId: string): string[] {
  const childrenOf = new Map<string | null, string[]>();
  for (const f of flat) {
    const p = f.parentId;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(f.id);
  }
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const c of childrenOf.get(id) ?? []) queue.push(c);
  }
  return out;
}

export function folderPathFromFlat<
  T extends { id: string; name: string; parentId: string | null },
>(folderId: string, flat: T[]): string {
  const map = new Map(flat.map((f) => [f.id, f]));
  const parts: string[] = [];
  let cur = map.get(folderId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? map.get(cur.parentId) : undefined;
  }
  return parts.join(" / ") || folderId;
}
