/**
 * 由子级 WBS（如 1.1、2.1.2）推导父级 WBS（1、2.1）；根节点无父返回 null。
 */
export function parentWbsFromChildWbs(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const parts = s
    .split(".")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (parts.length <= 1) return null;
  parts.pop();
  return parts.join(".");
}

/**
 * 在父节点下新增子节点时，按已有兄弟的 wbs 生成下一个编号（如父为 1 → 1.1、1.2；父为空则根 1、2…）。
 */
export function nextWbsForNewSiblingUnderParent(
  parentWbs: string | null | undefined,
  siblingWbsIds: (string | null | undefined)[],
): string {
  const p = parentWbs?.trim() || null;
  const siblings = siblingWbsIds
    .map((x) => (x ?? "").trim())
    .filter((x) => x.length > 0);
  if (!p) {
    let maxN = 0;
    for (const s of siblings) {
      if (/^\d+$/.test(s)) {
        const n = parseInt(s, 10);
        if (n > maxN) maxN = n;
      }
    }
    return String(maxN + 1);
  }
  const prefix = `${p}.`;
  let maxSuffix = 0;
  for (const s of siblings) {
    if (!s.startsWith(prefix)) continue;
    const rest = s.slice(prefix.length);
    const firstSeg = rest.split(".")[0] ?? "";
    if (/^\d+$/.test(firstSeg)) {
      const n = parseInt(firstSeg, 10);
      if (n > maxSuffix) maxSuffix = n;
    }
  }
  return `${p}.${maxSuffix + 1}`;
}

function wbsNumericSegments(raw: string): number[] | null {
  const parts = raw
    .split(".")
    .map((p) => p.trim())
    .filter((x) => x.length > 0);
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

/** WBS 自然序比较（空值排后）。 */
export function compareWbsId(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const as = (a ?? "").trim();
  const bs = (b ?? "").trim();
  if (!as && !bs) return 0;
  if (!as) return 1;
  if (!bs) return -1;
  const an = wbsNumericSegments(as);
  const bn = wbsNumericSegments(bs);
  if (an !== null && bn !== null) {
    const len = Math.max(an.length, bn.length);
    for (let i = 0; i < len; i++) {
      const av = an[i] ?? 0;
      const bv = bn[i] ?? 0;
      if (av !== bv) return av - bv;
    }
    return 0;
  }
  return as.localeCompare(bs, "zh-CN", { numeric: true });
}
