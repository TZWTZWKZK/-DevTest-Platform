import type { RequirementFlat } from "@/app/actions/requirements";
import { parseTaskProgressPercent } from "@/lib/task-progress-display";
import type { TreeNode } from "@/lib/tree";
export type RequirementSortableKey =
  | "wbsId"
  | "priority"
  | "status"
  | "taskProgress"
  | "planStartAt"
  | "planEndAt";

export type RequirementSortCriterion = {
  id: string;
  key: RequirementSortableKey;
  dir: "asc" | "desc";
};

export type RequirementSortState = {
  key: RequirementSortableKey;
  dir: "asc" | "desc";
};

export const REQUIREMENT_SORTABLE_KEYS: readonly RequirementSortableKey[] = [
  "wbsId",
  "priority",
  "status",
  "taskProgress",
  "planStartAt",
  "planEndAt",
] as const;

export type TaskProgressValueFilter =
  | { kind: "none" }
  | { kind: "eq"; v: number }
  | { kind: "gte"; v: number }
  | { kind: "lte"; v: number }
  | { kind: "between"; lo: number; hi: number };

type Node = TreeNode<RequirementFlat>;

const STATUS_ORDER: Record<RequirementFlat["status"], number> = {
  UNASSIGNED: 0,
  IN_DEVELOPMENT: 1,
  PENDING_VERIFICATION: 2,
  CLOSED: 3,
};

function normPriority(p: number | null | undefined): number {
  if (p === null || p === undefined) return -1;
  if (p >= 4) return 3;
  return p;
}

/** 将「1.2.3」式 WBS 拆成整数段；含非数字段时返回 null（改用字符串比较） */
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

function compareWbsValues(
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

export function taskProgressPassesValueFilter(
  raw: string | null | undefined,
  filter: TaskProgressValueFilter,
): boolean {
  if (filter.kind === "none") return true;
  const p = parseTaskProgressPercent(raw ?? "");
  if (p === null) return false;
  switch (filter.kind) {
    case "eq":
      return Math.abs(p - filter.v) < 0.0001;
    case "gte":
      return p >= filter.v;
    case "lte":
      return p <= filter.v;
    case "between":
      return p >= filter.lo && p <= filter.hi;
    default:
      return true;
  }
}

function compareOne(
  a: Node,
  b: Node,
  crit: RequirementSortCriterion | RequirementSortState,
): number {
  const mul = crit.dir === "asc" ? 1 : -1;
  switch (crit.key) {
    case "wbsId":
      return compareWbsValues(a.wbsId, b.wbsId) * mul;
    case "priority": {
      const an = a.priority === null || a.priority === undefined;
      const bn = b.priority === null || b.priority === undefined;
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      return (normPriority(a.priority) - normPriority(b.priority)) * mul;
    }
    case "status":
      return (
        (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * mul
      );
    case "taskProgress": {
      const ap = parseTaskProgressPercent(a.taskProgress ?? "");
      const bp = parseTaskProgressPercent(b.taskProgress ?? "");
      const an = ap === null;
      const bn = bp === null;
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      return (ap - bp) * mul;
    }
    case "planStartAt":
    case "planEndAt": {
      const key = crit.key;
      const av = a[key] ? new Date(a[key] as string).getTime() : NaN;
      const bv = b[key] ? new Date(b[key] as string).getTime() : NaN;
      const an = Number.isNaN(av);
      const bn = Number.isNaN(bv);
      if (an && bn) return 0;
      if (an) return 1;
      if (bn) return -1;
      return (av - bv) * mul;
    }
    default:
      return 0;
  }
}

function compareMany(
  a: Node,
  b: Node,
  criteria: Array<RequirementSortCriterion | RequirementSortState>,
): number {
  for (const c of criteria) {
    const r = compareOne(a, b, c);
    if (r !== 0) return r;
  }
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
}

/** 在各父节点下对子节点递归排序（不改变父子关系） */
export function sortRequirementTreeNodes(
  nodes: Node[],
  criteria: Array<RequirementSortCriterion | RequirementSortState>,
): Node[] {
  if (criteria.length === 0) return nodes;
  return [...nodes]
    .map((n) => ({
      ...n,
      children: sortRequirementTreeNodes(n.children, criteria),
    }))
    .sort((a, b) => compareMany(a, b, criteria));
}

export function isSortableRequirementColumn(
  k: string,
): k is RequirementSortableKey {
  return (REQUIREMENT_SORTABLE_KEYS as readonly string[]).includes(k);
}
