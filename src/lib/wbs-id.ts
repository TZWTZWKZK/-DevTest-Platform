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

const MAX_IMPORT_WBS_SUFFIX = 999;

export const IMPORT_DB_PARENT_REF_PREFIX = "__db__:";

export function importDbParentRef(dbId: string): string {
  return `${IMPORT_DB_PARENT_REF_PREFIX}${dbId}`;
}

export function parseImportDbParentRef(ref: string): string | null {
  return ref.startsWith(IMPORT_DB_PARENT_REF_PREFIX)
    ? ref.slice(IMPORT_DB_PARENT_REF_PREFIX.length)
    : null;
}

function allocateImportWbsWithSuffix(
  base: string,
  occupied: Set<string>,
  tryBaseFirst: boolean,
): string | null {
  if (tryBaseFirst && !occupied.has(base)) {
    occupied.add(base);
    return base;
  }
  for (let n = 1; n <= MAX_IMPORT_WBS_SUFFIX; n++) {
    const cand = `${base}${n}`;
    if (!occupied.has(cand)) {
      occupied.add(cand);
      return cand;
    }
  }
  return null;
}

/**
 * 导入需求时解析 WBS：同一批中相同 wbs 在末尾追加 1–999 自增后缀；
 * 仅出现一次的保持原值（若与库内/本批已占用冲突则同样递增后缀）。
 */
export function assignImportWbsIdsWithSuffix(
  bases: readonly (string | null | undefined)[],
  occupied: Set<string>,
): {
  wbsIds: (string | null)[];
  /** 因重复/冲突追加数字后缀时，对应无后缀的基 WBS（用于推断父节点） */
  wbsSuffixParentBase: (string | null)[];
  error?: string;
} {
  const trimmed = bases.map((b) => {
    const t = (b ?? "").trim();
    return t || null;
  });

  const dupCount = new Map<string, number>();
  for (const b of trimmed) {
    if (!b) continue;
    dupCount.set(b, (dupCount.get(b) ?? 0) + 1);
  }

  const seenIndex = new Map<string, number>();
  const wbsIds: (string | null)[] = [];
  const wbsSuffixParentBase: (string | null)[] = [];

  for (const b of trimmed) {
    if (!b) {
      wbsIds.push(null);
      wbsSuffixParentBase.push(null);
      continue;
    }
    const idx = seenIndex.get(b) ?? 0;
    seenIndex.set(b, idx + 1);
    const isDupGroup = (dupCount.get(b) ?? 0) > 1;
    const tryBaseFirst = !isDupGroup || idx === 0;

    const assigned = allocateImportWbsWithSuffix(b, occupied, tryBaseFirst);
    if (!assigned) {
      return {
        wbsIds: [],
        wbsSuffixParentBase: [],
        error: `WBS 编号「${b}」无法分配唯一后缀（1–${MAX_IMPORT_WBS_SUFFIX} 均已占用或与库内冲突）`,
      };
    }
    wbsIds.push(assigned);
    wbsSuffixParentBase.push(assigned !== b ? b : null);
  }

  return { wbsIds, wbsSuffixParentBase };
}

/** 去掉末尾 1–999 数字后缀，返回基串（如 OZSJ-1 首页1 → OZSJ-1 首页） */
function importWbsStripNumericSuffix(
  wbs: string,
): { base: string; suffix: number } | null {
  for (let n = MAX_IMPORT_WBS_SUFFIX; n >= 1; n--) {
    const suffix = String(n);
    if (!wbs.endsWith(suffix)) continue;
    const base = wbs.slice(0, -suffix.length);
    if (!base) continue;
    return { base, suffix: n };
  }
  return null;
}

function inferParentRefFromImportNumericSuffix(
  selfRef: string,
  value: string,
  wbsToParentRef: ReadonlyMap<string, string>,
  dataIdToParentRef: ReadonlyMap<string, string>,
): string | null {
  const stripped = importWbsStripNumericSuffix(value);
  if (!stripped) return null;
  const tryRef = (ref: string | undefined): string | null => {
    if (!ref || ref === selfRef) return null;
    return ref;
  };
  const { base } = stripped;
  return (
    tryRef(wbsToParentRef.get(base)) ?? tryRef(dataIdToParentRef.get(base))
  );
}

/** 导入节点标识：`data_id` + 空格 + `任务名称`（与 Excel 中 wbs_id 格式一致）。 */
export function importNodeCompositeKey(
  dataId: string | null | undefined,
  title: string | null | undefined,
): string | null {
  const d = (dataId ?? "").trim();
  const t = (title ?? "").trim();
  if (!d) return t || null;
  if (!t) return d;
  return `${d} ${t}`;
}

/** 从 wbs_id（data_id + 任务名称）解析出 data_id 与标题，供库内查找父节点。 */
export function parseImportCompositeWbsKey(
  wbsId: string,
): { dataId: string; title: string } | null {
  const w = wbsId.trim();
  if (!w) return null;
  const sp = w.indexOf(" ");
  if (sp <= 0) return null;
  const dataId = w.slice(0, sp).trim();
  const title = w.slice(sp + 1).trim();
  if (!dataId || !title) return null;
  return { dataId, title };
}

/** 导入写入时：wbs_id 为空为根；否则按 wbs_id（= 父节点 data_id + 任务名称）在 idMap 中查父节点。 */
export function resolveImportParentIdFromIdMap(
  parentPointer: string | null | undefined,
  idMap: ReadonlyMap<string, string>,
): string | null {
  const w = (parentPointer ?? "").trim();
  if (!w) return null;
  return idMap.get(w) ?? null;
}

/** 非空 wbs_id 即指向父节点的 composite 键。 */
export function importWbsIdAsParentPointer(
  wbsId: string | null | undefined,
): string | null {
  const w = (wbsId ?? "").trim();
  return w || null;
}

/** 构建导入批次 composite 键 → 父 wbs_id 映射，用于排序。 */
export function buildImportBatchParentPointerMap(
  rows: readonly {
    dataId: string | null;
    title: string;
    wbsId: string | null;
  }[],
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const x of rows) {
    const composite = importNodeCompositeKey(x.dataId, x.title);
    if (composite) {
      map.set(composite, importWbsIdAsParentPointer(x.wbsId));
    }
  }
  return map;
}

/** 按父指针链计算深度（父节点先于子节点写入）。 */
export function importDepthByParentPointer(
  parentPointer: string | null | undefined,
  batchKeyToParentPointer: ReadonlyMap<string, string | null>,
): number {
  let cur = (parentPointer ?? "").trim();
  if (!cur) return 0;
  let depth = 0;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    depth++;
    if (!batchKeyToParentPointer.has(cur)) break;
    const next = (batchKeyToParentPointer.get(cur) ?? "").trim();
    if (!next) break;
    cur = next;
  }
  return depth;
}

/** 导入父节点：wbs_id 为空为根；否则挂到 data_id = wbs_id 的节点下（推断阶段用）。 */
export function resolveImportParentRefByWbsDataId(
  selfRef: string,
  wbsId: string | null | undefined,
  dataIdToNodeRef: ReadonlyMap<string, string>,
): string | null {
  const w = (wbsId ?? "").trim();
  if (!w) return null;
  const ref = dataIdToNodeRef.get(w);
  if (!ref || ref === selfRef) return null;
  return ref;
}

/** 按 wbs_id→data_id 父链计算深度，保证导入时父节点先于子节点。 */
export function importDepthByWbsDataParentLink(
  wbsId: string | null | undefined,
  batchDataIdToWbs: ReadonlyMap<string, string | null>,
): number {
  const w = (wbsId ?? "").trim();
  if (!w) return 0;
  let depth = 0;
  let cur = w;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    depth++;
    if (!batchDataIdToWbs.has(cur)) break;
    const parentWbs = (batchDataIdToWbs.get(cur) ?? "").trim();
    if (!parentWbs) break;
    cur = parentWbs;
  }
  return depth;
}

/** 导入时每个 wbs_id 槽位由哪条行占用（先库内、后文件行序，重复 wbs 跳过后续）。 */
export function buildImportWbsWriteOwnerKey(
  existing: readonly {
    wbsId: string | null | undefined;
    dataId: string | null | undefined;
    dbId: string;
  }[],
  importRows: readonly {
    wbsId: string | null;
    dataId: string | null;
    nodeRef: string;
    sourceRowIndex: number;
  }[],
  updatingDataIds: ReadonlySet<string>,
): Map<string, string> {
  const owner = new Map<string, string>();

  for (const r of existing) {
    const w = (r.wbsId ?? "").trim();
    if (!w) continue;
    if (r.dataId && updatingDataIds.has(r.dataId)) continue;
    if (!owner.has(w)) owner.set(w, (r.dataId ?? "").trim() || r.dbId);
  }

  const sorted = [...importRows].sort(
    (a, b) => a.sourceRowIndex - b.sourceRowIndex,
  );
  for (const x of sorted) {
    const w = (x.wbsId ?? "").trim();
    if (!w) continue;
    if (!owner.has(w)) {
      owner.set(w, (x.dataId ?? "").trim() || x.nodeRef);
    }
  }

  return owner;
}

/** 重复 wbs_id 不写入库（返回 null）；仅槽位代表行保留原 wbs_id。 */
export function importWbsIdForWrite(
  wbsId: string | null | undefined,
  dataId: string | null | undefined,
  nodeRef: string,
  wbsWriteOwner: ReadonlyMap<string, string>,
): string | null {
  const w = (wbsId ?? "").trim();
  if (!w) return null;
  const selfKey = (dataId ?? "").trim() || nodeRef;
  return wbsWriteOwner.get(w) === selfKey ? w : null;
}

/** 解析 WBS 编号与标题后缀，如 "OZSJ-11 第三方许可通知页面"。 */
export function parseImportWbsCodeAndTitleSuffix(raw: string): {
  fullCode: string;
  titleSuffix: string | null;
} | null {
  const s = raw.trim();
  if (!s) return null;
  const sp = s.indexOf(" ");
  if (sp <= 0) return { fullCode: s, titleSuffix: null };
  const titleSuffix = s.slice(sp + 1).trim();
  return {
    fullCode: s.slice(0, sp).trim(),
    titleSuffix: titleSuffix || null,
  };
}

/** 连字符+数字编号父级：OZSJ-11 → OZSJ-1；已是根（OZSJ-1）返回 null。 */
export function parentHyphenNumericCode(fullCode: string): string | null {
  const m = fullCode.match(/^(.+-)(\d+)$/);
  if (!m) return null;
  const num = m[2];
  if (num.length <= 1) return null;
  return m[1] + num.slice(0, -1);
}

/** 在已登记 WBS 中按编号前缀查找节点（如 OZSJ-1 匹配 "OZSJ-1 首页"）。 */
export function findImportWbsNodeRefByCodePrefix(
  parentCode: string,
  wbsToNodeRef: ReadonlyMap<string, string>,
): string | null {
  const pc = parentCode.trim();
  if (!pc) return null;
  if (wbsToNodeRef.has(pc)) return wbsToNodeRef.get(pc)!;

  let best: string | null = null;
  let bestLen = Infinity;
  for (const [key, ref] of wbsToNodeRef) {
    if (key === pc || key.startsWith(`${pc} `)) {
      if (key.length < bestLen) {
        bestLen = key.length;
        best = ref;
      }
    }
  }
  return best;
}

/** WBS 标题后缀匹配任务名称（子节点也可作父节点，如中间层无 wbs_id）。 */
export function resolveImportParentByTitleSuffix(
  selfRef: string,
  titleSuffix: string,
  titleToNodeRef: ReadonlyMap<string, string>,
): string | null {
  const suffix = titleSuffix.trim();
  if (!suffix) return null;

  const exact = titleToNodeRef.get(suffix);
  if (exact && exact !== selfRef) return exact;

  let best: { ref: string; len: number } | null = null;
  for (const [title, ref] of titleToNodeRef) {
    if (ref === selfRef) continue;
    if (title === suffix || suffix.startsWith(title) || title.startsWith(suffix)) {
      if (!best || title.length > best.len) {
        best = { ref, len: title.length };
      }
    }
  }
  return best?.ref ?? null;
}

function resolveImportParentByHyphenNumeric(
  selfRef: string,
  codeOrId: string,
  wbsToNodeRef: ReadonlyMap<string, string>,
  dataIdToNodeRef: ReadonlyMap<string, string>,
): string | null {
  const tryRef = (ref: string | undefined | null): string | null => {
    if (!ref || ref === selfRef) return null;
    return ref;
  };

  const parsed = parseImportWbsCodeAndTitleSuffix(codeOrId);
  const fullCode = parsed?.fullCode ?? codeOrId.trim();
  const parentCode = parentHyphenNumericCode(fullCode);
  if (!parentCode) return null;

  return (
    tryRef(findImportWbsNodeRefByCodePrefix(parentCode, wbsToNodeRef)) ??
    tryRef(dataIdToNodeRef.get(parentCode))
  );
}

/** 任务名称 → 节点引用（库内 + 本批；子节点也可作父节点）。 */
export function buildImportTitleToNodeRef(
  existing: readonly { title: string; dbId: string }[],
  importRows: readonly {
    title: string;
    nodeRef: string;
    sourceRowIndex: number;
  }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of existing) {
    const t = r.title.trim();
    if (t && !map.has(t)) map.set(t, importDbParentRef(r.dbId));
  }
  const sorted = [...importRows].sort(
    (a, b) => a.sourceRowIndex - b.sourceRowIndex,
  );
  for (const x of sorted) {
    const t = x.title.trim();
    if (t && !map.has(t)) map.set(t, x.nodeRef);
  }
  return map;
}

/** 导入排序深度：点分 WBS 或连字符数字层级（OZSJ-1→1，OZSJ-11→2）。 */
export function importWbsSortDepth(raw: string | null | undefined): number {
  const s = (raw ?? "").trim();
  if (!s) return 0;

  const parsed = parseImportWbsCodeAndTitleSuffix(s);
  const code = parsed?.fullCode ?? s;
  const dotDepth = wbsSegmentDepth(code);
  if (dotDepth > 1) return dotDepth;

  const m = code.match(/-(\d+)$/);
  if (m) return m[1].length;

  return dotDepth || 1;
}

/** WBS 点分层级深度（如 1→1，1.1→2）；无 WBS 为 0。 */
export function wbsSegmentDepth(raw: string | null | undefined): number {
  const s = (raw ?? "").trim();
  if (!s) return 0;
  return s
    .split(".")
    .map((x) => x.trim())
    .filter((x) => x.length > 0).length;
}

/** 导入写入顺序：先根/浅层 WBS，同层按 WBS 自然序。 */
export function compareImportProcessOrder(
  a: {
    wbsId: string | null;
    dataId?: string | null;
    sourceRowIndex?: number;
  },
  b: {
    wbsId: string | null;
    dataId?: string | null;
    sourceRowIndex?: number;
  },
): number {
  const depthA = Math.max(
    importWbsSortDepth(a.wbsId),
    importWbsSortDepth(a.dataId ?? null),
  );
  const depthB = Math.max(
    importWbsSortDepth(b.wbsId),
    importWbsSortDepth(b.dataId ?? null),
  );
  if (depthA !== depthB) return depthA - depthB;

  const byWbs = compareWbsId(a.wbsId, b.wbsId);
  if (byWbs !== 0) return byWbs;

  const byData = compareWbsId(a.dataId ?? null, b.dataId ?? null);
  if (byData !== 0) return byData;

  return (a.sourceRowIndex ?? 0) - (b.sourceRowIndex ?? 0);
}

/**
 * 阶段一：按 WBS 自然序排列去重（相同 wbs 跳过后续），建立 wbs → 节点引用。
 * 库内已有节点优先；本批仅首条同 wbs 行登记，供后续按 WBS 父段挂子节点。
 */
export function buildImportWbsToNodeRef(
  existing: readonly { wbsId: string | null | undefined; dbId: string }[],
  importRows: readonly {
    wbsId: string | null;
    nodeRef: string;
    sourceRowIndex: number;
  }[],
): Map<string, string> {
  const wbsToNodeRef = new Map<string, string>();

  const existingSorted = existing
    .map((r) => ({ wbs: (r.wbsId ?? "").trim(), id: r.dbId }))
    .filter((x) => x.wbs)
    .sort((a, b) => compareWbsId(a.wbs, b.wbs));
  for (const { wbs, id } of existingSorted) {
    wbsToNodeRef.set(wbs, importDbParentRef(id));
  }

  const importSorted = importRows
    .filter((x) => (x.wbsId ?? "").trim())
    .sort(
      (a, b) =>
        compareWbsId(a.wbsId, b.wbsId) ||
        a.sourceRowIndex - b.sourceRowIndex,
    );
  for (const x of importSorted) {
    const w = x.wbsId!.trim();
    if (wbsToNodeRef.has(w)) continue;
    wbsToNodeRef.set(w, x.nodeRef);
  }

  return wbsToNodeRef;
}

/** 本批导入中，每个 wbs 槽位由哪条行代表（data_id 优先，否则 nodeRef）。 */
export function buildImportWbsTreeOwnerKey(
  existing: readonly {
    wbsId: string | null | undefined;
    dataId: string | null | undefined;
    dbId: string;
  }[],
  importRows: readonly {
    wbsId: string | null;
    dataId: string | null;
    nodeRef: string;
    sourceRowIndex: number;
  }[],
): Map<string, string> {
  const owner = new Map<string, string>();

  const existingSorted = existing
    .map((r) => ({
      wbs: (r.wbsId ?? "").trim(),
      key: (r.dataId ?? "").trim() || r.dbId,
    }))
    .filter((x) => x.wbs)
    .sort((a, b) => compareWbsId(a.wbs, b.wbs));
  for (const { wbs, key } of existingSorted) {
    owner.set(wbs, key);
  }

  const importSorted = importRows
    .filter((x) => (x.wbsId ?? "").trim())
    .sort(
      (a, b) =>
        compareWbsId(a.wbsId, b.wbsId) ||
        a.sourceRowIndex - b.sourceRowIndex,
    );
  for (const x of importSorted) {
    const w = x.wbsId!.trim();
    if (owner.has(w)) continue;
    owner.set(w, (x.dataId ?? "").trim() || x.nodeRef);
  }

  return owner;
}

/**
 * 阶段二：推断父节点引用（文件内 oldId 或 __db__:uuid）。
 * 1. wbs_id 与某行/库内 data_id 相同 → 父节点；
 * 2. 同 wbs 重复行（非槽位代表）→ 挂到 wbs 槽位节点下；
 * 3. WBS 标题后缀匹配任务名称（中间子节点作父）；
 * 4. WBS 点分父段（1.1→1）→ wbs / data_id 匹配；
 * 5. 连字符数字父段（OZSJ-11→OZSJ-1）→ wbs / data_id 匹配；
 * 6. data_id 点分 / 连字符数字父段。
 */
export function resolveImportParentRef(
  selfRef: string,
  wbsId: string | null | undefined,
  dataId: string | null | undefined,
  wbsToNodeRef: ReadonlyMap<string, string>,
  dataIdToNodeRef: ReadonlyMap<string, string>,
  wbsTreeOwnerKey: ReadonlyMap<string, string>,
  titleToNodeRef: ReadonlyMap<string, string>,
): string | null {
  const tryRef = (ref: string | undefined): string | null => {
    if (!ref || ref === selfRef) return null;
    return ref;
  };

  const w = (wbsId ?? "").trim();
  const d = (dataId ?? "").trim();

  if (w) {
    const byWbsEqDataId = tryRef(dataIdToNodeRef.get(w));
    if (byWbsEqDataId) return byWbsEqDataId;

    const ownerKey = wbsTreeOwnerKey.get(w);
    if (ownerKey) {
      const selfKey = d || selfRef;
      if (ownerKey !== selfKey) {
        const slotParent = tryRef(wbsToNodeRef.get(w));
        if (slotParent) return slotParent;
      }
    }

    const wbsParsed = parseImportWbsCodeAndTitleSuffix(w);
    if (wbsParsed?.titleSuffix) {
      const byTitle = resolveImportParentByTitleSuffix(
        selfRef,
        wbsParsed.titleSuffix,
        titleToNodeRef,
      );
      if (byTitle) return byTitle;
    }

    const pw = parentWbsFromChildWbs(w);
    if (pw) {
      const byWbs = tryRef(wbsToNodeRef.get(pw));
      if (byWbs) return byWbs;
      const byDataSeg = tryRef(dataIdToNodeRef.get(pw));
      if (byDataSeg) return byDataSeg;
    }

    const byHyphenWbs = resolveImportParentByHyphenNumeric(
      selfRef,
      w,
      wbsToNodeRef,
      dataIdToNodeRef,
    );
    if (byHyphenWbs) return byHyphenWbs;
  }

  if (d) {
    const pd = parentWbsFromChildWbs(d);
    if (pd) {
      const byData = tryRef(dataIdToNodeRef.get(pd));
      if (byData) return byData;
      const byWbsSeg = tryRef(wbsToNodeRef.get(pd));
      if (byWbsSeg) return byWbsSeg;
    }

    const byHyphenData = resolveImportParentByHyphenNumeric(
      selfRef,
      d,
      wbsToNodeRef,
      dataIdToNodeRef,
    );
    if (byHyphenData) return byHyphenData;
  }

  return null;
}

/** @deprecated 请使用 resolveImportParentRef */
export function resolveImportParentRefFromWbsTree(
  selfRef: string,
  wbsId: string | null | undefined,
  wbsToNodeRef: ReadonlyMap<string, string>,
): string | null {
  return resolveImportParentRef(
    selfRef,
    wbsId,
    null,
    wbsToNodeRef,
    new Map(),
    new Map(),
    new Map(),
  );
}

/** 新建行是否可写入 wbs_id（同 wbs 仅槽位代表行保留，避免迭代内唯一约束冲突）。 */
export function importEffectiveWbsIdForCreate(
  wbsId: string | null | undefined,
  dataId: string | null | undefined,
  nodeRef: string,
  wbsTreeOwnerKey: ReadonlyMap<string, string>,
): string | null {
  const w = (wbsId ?? "").trim();
  if (!w) return null;
  const ownerKey = wbsTreeOwnerKey.get(w);
  if (!ownerKey) return w;
  const selfKey = (dataId ?? "").trim() || nodeRef;
  return ownerKey === selfKey ? w : null;
}

/**
 * 导入时根据 wbs_id / data_id 推断父节点引用（文件内 oldId 或 __db__:uuid）：
 * 1. 本行 wbs_id 与某行/库内 data_id 相同 → 该 data_id 为父；
 * 2. 去掉 wbs_id 末尾 1–999 数字后缀后的基串与某行 wbs/data_id 相同 → 该行为父；
 * 3. WBS 点分层级（如 1.1→1）与 data_id / wbs_id 匹配；
 * 4. 本行 data_id 的点分父段与某行 data_id 相同 → 该 data_id 为父。
 */
export function inferImportParentRefByWbsAndDataId(
  selfRef: string,
  wbsId: string | null | undefined,
  dataId: string | null | undefined,
  wbsToParentRef: ReadonlyMap<string, string>,
  dataIdToParentRef: ReadonlyMap<string, string>,
): string | null {
  const tryRef = (ref: string | undefined): string | null => {
    if (!ref || ref === selfRef) return null;
    return ref;
  };

  const w = (wbsId ?? "").trim();
  if (w) {
    const hit = tryRef(dataIdToParentRef.get(w));
    if (hit) return hit;

    const bySuffix = inferParentRefFromImportNumericSuffix(
      selfRef,
      w,
      wbsToParentRef,
      dataIdToParentRef,
    );
    if (bySuffix) return bySuffix;

    const pw = parentWbsFromChildWbs(w);
    if (pw) {
      const byData = tryRef(dataIdToParentRef.get(pw));
      if (byData) return byData;
      const byWbs = tryRef(wbsToParentRef.get(pw));
      if (byWbs) return byWbs;
    }
  }

  const d = (dataId ?? "").trim();
  if (d) {
    const bySuffix = inferParentRefFromImportNumericSuffix(
      selfRef,
      d,
      wbsToParentRef,
      dataIdToParentRef,
    );
    if (bySuffix) return bySuffix;

    const pd = parentWbsFromChildWbs(d);
    if (pd) {
      const byData = tryRef(dataIdToParentRef.get(pd));
      if (byData) return byData;
    }
  }

  return null;
}
