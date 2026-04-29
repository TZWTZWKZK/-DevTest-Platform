"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  bulkDeleteRequirements,
  bulkMoveRequirements,
  createRequirementNode,
  duplicateRequirementAsChild,
  getRequirementsExportAllForIteration,
  getRequirementsExportRows,
  importRequirementsCsv,
  listRequirementsFlat,
  patchRequirementRowFields,
  type ImportRequirementRow,
  type IterationOption,
  type RequirementExportRow,
  type RequirementFlat,
} from "@/app/actions/requirements";
import { RequirementPrioritySelect } from "@/components/RequirementPrioritySelect";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import {
  REQUIREMENT_COLUMN_LABELS,
  type RequirementColumnKey,
  useRequirementTreeColumns,
} from "@/hooks/useRequirementTreeColumns";
import { usePagination } from "@/hooks/usePagination";
import {
  formatTaskProgressAsPercentIfNumeric,
  parseTaskProgressPercent,
  taskProgressPercentPillClass,
} from "@/lib/task-progress-display";
import {
  getGlobalIterationProductPreference,
  getGlobalRequirementIterationPreference,
  saveGlobalIterationProductPreference,
  saveGlobalRequirementIterationPreference,
} from "@/app/actions/executions";
import { listProductOptions, type ProductOption } from "@/app/actions/products";
import { deriveRequirementStatusFromTaskProgress } from "@/lib/requirement-progress-status";
import { beijingDatetimeLocalToIsoOrNull, formatIsoBeijing } from "@/lib/timezone-cn";
import {
  isSortableRequirementColumn,
  type RequirementSortableKey,
  sortRequirementTreeNodes,
  taskProgressPassesValueFilter,
  type TaskProgressValueFilter,
} from "@/lib/requirement-tree-sort";
import { buildTree, type TreeNode } from "@/lib/tree";
import * as XLSX from "xlsx";

type Node = TreeNode<RequirementFlat>;

const requirementStatusLabel = {
  UNASSIGNED: "未分配",
  IN_DEVELOPMENT: "开发中",
  PENDING_VERIFICATION: "待验证",
  CLOSED: "已上线",
} as const;

const requirementStatusBadgeClass = {
  UNASSIGNED: "border-violet-500/80 bg-violet-50 text-violet-800",
  IN_DEVELOPMENT: "border-red-500/80 bg-red-50 text-red-800",
  PENDING_VERIFICATION: "border-emerald-500/80 bg-emerald-50 text-emerald-800",
  CLOSED: "border-blue-500/80 bg-blue-50 text-blue-800",
} as const;

type RequirementStatus = RequirementFlat["status"];

const DEFAULT_REQUIREMENT_DESCRIPTION_TEMPLATE = [
  "描述：",
  "",
  "前置条件：",
  "",
  "正常流程&异常流程：",
  "",
  "输入/输出：",
  "",
  "验收标准(如何操作界面来实现/复现需求/测试验证)：",
  "",
].join("\n");

/** 「1 天」按 24 小时窗口比较计划结束时间（与当前时间差） */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 整行浅色底：未分配 / 开发中且将逾期或≤1天 → 红；待验证 → 绿；已上线 → 蓝；开发中且距结束>1天 → 黄 */
function requirementRowSurfaceClass(
  status: RequirementStatus,
  planEndAt: string | null | undefined,
  nowMs: number,
): string {
  if (status === "CLOSED") {
    return "bg-blue-50/70 hover:bg-blue-100/80";
  }
  if (status === "PENDING_VERIFICATION") {
    return "bg-emerald-50/70 hover:bg-emerald-100/80";
  }
  if (status === "UNASSIGNED") {
    return "bg-red-50/70 hover:bg-red-100/80";
  }
  if (status === "IN_DEVELOPMENT") {
    if (!planEndAt) return "";
    const endMs = new Date(planEndAt).getTime();
    if (Number.isNaN(endMs)) return "";
    if (endMs - nowMs <= MS_PER_DAY) {
      return "bg-red-50/70 hover:bg-red-100/80";
    }
    return "bg-amber-50/70 hover:bg-amber-100/80";
  }
  return "";
}

function formatTs(iso: string): string {
  return formatIsoBeijing(iso);
}

function datetimeLocalToIsoOrNull(v: string): string | null {
  return beijingDatetimeLocalToIsoOrNull(v);
}

function matchesText(hay: string | null | undefined, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return String(hay ?? "").toLowerCase().includes(n);
}

function toMsAtBoundary(isoDate: string, endOfDay: boolean): number | null {
  if (!isoDate) return null;
  const d = new Date(
    endOfDay ? `${isoDate}T23:59:59.999` : `${isoDate}T00:00:00`,
  );
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function inDateRange(
  iso: string | null | undefined,
  fromMs: number | null,
  toMs: number | null,
): boolean {
  if (fromMs === null && toMs === null) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (fromMs !== null && t < fromMs) return false;
  if (toMs !== null && t > toMs) return false;
  return true;
}

function requirementCell(n: RequirementFlat, key: RequirementColumnKey) {
  switch (key) {
    case "title":
      return (
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate text-zinc-800">{n.title}</span>
          {n.status === "PENDING_VERIFICATION" ? (
            <span
              className="inline-flex h-4 shrink-0 items-center rounded-full border border-emerald-300 bg-emerald-50 px-1.5 text-[10px] font-semibold leading-none text-emerald-700"
              title="待验证"
              aria-label="待验证"
            >
              ✓
            </span>
          ) : null}
        </span>
      );
    case "wbsId":
      return (
        <span className="block truncate font-mono text-xs tabular-nums text-zinc-600">
          {n.wbsId?.trim() ? n.wbsId : "—"}
        </span>
      );
    case "submitter":
      return (
        <span className="block truncate text-zinc-600">
          {n.submitter ?? "—"}
        </span>
      );
    case "devOwner":
      return (
        <span className="block truncate text-zinc-600">{n.devOwner ?? "—"}</span>
      );
    case "testOwner":
      return (
        <span className="block truncate text-zinc-600">
          {n.testOwner ?? "—"}
        </span>
      );
    case "planStartAt":
      return (
        <span className="block truncate tabular-nums text-zinc-600">
          {n.planStartAt ? formatTs(n.planStartAt) : "—"}
        </span>
      );
    case "planEndAt":
      return (
        <span className="block truncate tabular-nums text-zinc-600">
          {n.planEndAt ? formatTs(n.planEndAt) : "—"}
        </span>
      );
    case "createdAt":
      return (
        <span className="block truncate tabular-nums text-zinc-600">
          {formatTs(n.createdAt)}
        </span>
      );
    case "updatedAt":
      return (
        <span className="block truncate tabular-nums text-zinc-600">
          {formatTs(n.updatedAt)}
        </span>
      );
    default:
      return null;
  }
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function cellForImport(
  cells: string[],
  headerIndex: Map<string, number>,
  headerName: string,
): string {
  const i = headerIndex.get(headerName);
  if (i === undefined || i < 0 || i >= cells.length) return "";
  return cells[i] ?? "";
}

function titleCellForImport(cells: string[], headerIndex: Map<string, number>) {
  const a = cellForImport(cells, headerIndex, "任务名称").trim();
  if (a !== "") return a;
  return cellForImport(cells, headerIndex, "标题");
}

function progressCellsForImport(
  cells: string[],
  headerIndex: Map<string, number>,
): Pick<ImportRequirementRow, "任务进度" | "最新进展情况"> {
  const 任务进度 = cellForImport(cells, headerIndex, "任务进度");
  let 最新进展情况 = cellForImport(cells, headerIndex, "最新进展情况");
  const legacy = cellForImport(
    cells,
    headerIndex,
    "任务进度/最新进展情况",
  ).trim();
  if (
    !任务进度.trim() &&
    !最新进展情况.trim() &&
    legacy !== ""
  ) {
    最新进展情况 = legacy;
  }
  return { 任务进度, 最新进展情况 };
}

function parseRequirementImportTable(
  headerRow: unknown[],
  bodyMatrix: unknown[][],
): ImportRequirementRow[] | { error: string } {
  const headerCells = headerRow.map((h) => String(h ?? "").trim());
  const headerIndex = new Map<string, number>();
  headerCells.forEach((h, idx) => {
    if (h) headerIndex.set(h, idx);
  });
  if (!headerIndex.has("任务名称") && !headerIndex.has("标题")) {
    return {
      error:
        "表头须包含「任务名称」或「标题」列；请使用本页导出的 Excel 文件（或兼容的旧版 CSV）。",
    };
  }

  const rows: ImportRequirementRow[] = [];
  for (const rawRow of bodyMatrix) {
    const cells = rawRow.map((c) => String(c ?? ""));
    if (cells.every((c) => !c.trim())) continue;
    const prog = progressCellsForImport(cells, headerIndex);
    rows.push({
      节点ID: cellForImport(cells, headerIndex, "节点ID"),
      父节点ID: cellForImport(cells, headerIndex, "父节点ID"),
      data_id:
        cellForImport(cells, headerIndex, "data_id") ||
        cellForImport(cells, headerIndex, "数据ID"),
      wbs_id:
        cellForImport(cells, headerIndex, "wbs_id") ||
        cellForImport(cells, headerIndex, "WBS编号"),
      任务名称: titleCellForImport(cells, headerIndex),
      优先级: cellForImport(cells, headerIndex, "优先级"),
      状态: cellForImport(cells, headerIndex, "状态"),
      任务进度: prog.任务进度,
      最新进展情况: prog.最新进展情况,
      提交人: cellForImport(cells, headerIndex, "提交人"),
      开发负责人: cellForImport(cells, headerIndex, "开发负责人"),
      测试负责人: cellForImport(cells, headerIndex, "测试负责人"),
      计划开始时间: cellForImport(cells, headerIndex, "计划开始时间"),
      计划结束时间: cellForImport(cells, headerIndex, "计划结束时间"),
    });
  }
  return rows;
}

function parseRequirementImportCsv(
  text: string,
): ImportRequirementRow[] | { error: string } {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = t.split("\n").filter((ln) => ln.trim() !== "");
  if (lines.length < 2) {
    return { error: "文件至少需要表头与一行数据" };
  }
  const headerCells = splitCsvLine(lines[0]).map((h) => h.trim());
  const bodyRows: string[][] = [];
  for (let li = 1; li < lines.length; li++) {
    bodyRows.push(splitCsvLine(lines[li]));
  }
  return parseRequirementImportTable(headerCells, bodyRows);
}

function parseRequirementImportExcel(
  buf: ArrayBuffer,
): ImportRequirementRow[] | { error: string } {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "array" });
  } catch {
    return { error: "无法解析 Excel 文件，请使用 .xlsx 或 .xls。" };
  }
  if (!wb.SheetNames?.length) {
    return { error: "Excel 文件中没有工作表" };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: "",
    blankrows: false,
  });
  if (!matrix.length) {
    return { error: "工作表为空" };
  }
  const headerRow = matrix[0] as unknown[];
  const bodyMatrix = matrix.slice(1) as unknown[][];
  return parseRequirementImportTable(headerRow, bodyMatrix);
}

function resolveInitialIterationId(
  iterations: IterationOption[],
  urlIterationId?: string,
): string {
  const u = urlIterationId?.trim();
  if (u && iterations.some((it) => it.id === u)) return u;
  return iterations[0]?.id ?? "";
}

export function RequirementTreeClient({
  initialIterations,
  initialIterationId,
  initialFocusNodeId,
}: {
  initialIterations: IterationOption[];
  /** 来自 URL，返回详情时定位到同一迭代 */
  initialIterationId?: string;
  /** 来自 URL，展开并滚动到该行 */
  initialFocusNodeId?: string;
}) {
  const router = useRouter();
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productId, setProductId] = useState("");
  const productPrefHydratedRef = useRef(false);
  const hasUrlIterationId = !!initialIterationId?.trim();
  const [iterationId, setIterationId] = useState(() =>
    resolveInitialIterationId(initialIterations, initialIterationId),
  );
  const requirementIterPrefHydratedRef = useRef(false);

  useEffect(() => {
    const u = initialIterationId?.trim();
    if (!u) return;
    if (initialIterations.some((it) => it.id === u)) {
      setIterationId((prev) => (prev === u ? prev : u));
    }
  }, [initialIterationId, initialIterations]);

  useEffect(() => {
    if (hasUrlIterationId) {
      requirementIterPrefHydratedRef.current = true;
      return;
    }
    let cancelled = false;
    void (async () => {
      const pref = await getGlobalRequirementIterationPreference();
      if (cancelled) return;
      const candidate = (pref.iterationId ?? "").trim();
      if (candidate && initialIterations.some((it) => it.id === candidate)) {
        setIterationId((prev) => (prev === candidate ? prev : candidate));
      }
      requirementIterPrefHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [hasUrlIterationId, initialIterations]);

  useEffect(() => {
    if (hasUrlIterationId || !requirementIterPrefHydratedRef.current) return;
    const t = window.setTimeout(() => {
      void saveGlobalRequirementIterationPreference({ iterationId });
    }, 400);
    return () => clearTimeout(t);
  }, [hasUrlIterationId, iterationId]);
  const visibleIterations = useMemo(
    () =>
      productId
        ? initialIterations.filter((it) => it.productId === productId)
        : initialIterations,
    [initialIterations, productId],
  );

  useEffect(() => {
    void (async () => {
      try {
        const ps = await listProductOptions();
        setProducts(ps);
      } catch {
        setProducts([]);
      }
    })();
  }, []);

  useEffect(() => {
    const u = initialIterationId?.trim();
    if (!u) return;
    const hit = initialIterations.find((it) => it.id === u);
    if (!hit) return;
    setProductId(hit.productId);
  }, [initialIterationId, initialIterations]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pref = await getGlobalIterationProductPreference();
      if (cancelled) return;
      const candidate = (pref.productId ?? "").trim();
      if (candidate) setProductId((prev) => prev || candidate);
      productPrefHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (productId) return;
    if (products.length > 0) setProductId(products[0]!.id);
  }, [productId, products]);

  useEffect(() => {
    if (!productPrefHydratedRef.current || !productId) return;
    const t = window.setTimeout(() => {
      void saveGlobalIterationProductPreference({ productId });
    }, 400);
    return () => clearTimeout(t);
  }, [productId]);

  useEffect(() => {
    if (visibleIterations.length === 0) {
      setIterationId("");
      return;
    }
    if (!visibleIterations.some((it) => it.id === iterationId)) {
      setIterationId(visibleIterations[0]!.id);
    }
  }, [visibleIterations, iterationId]);

  const [flat, setFlat] = useState<RequirementFlat[]>([]);
  const [loading, setLoading] = useState(false);
  const [rootErr, setRootErr] = useState<string | null>(null);
  const [rootTitle, setRootTitle] = useState("");
  const [rootPriority, setRootPriority] = useState<string>("");
  const [rootStatus, setRootStatus] =
    useState<RequirementStatus>("UNASSIGNED");
  const [rootSubmitter, setRootSubmitter] = useState("");
  const [rootDevOwner, setRootDevOwner] = useState("");
  const [rootTestOwner, setRootTestOwner] = useState("");
  const [rootDescription, setRootDescription] = useState("");
  const [rootPlanStart, setRootPlanStart] = useState("");
  const [rootPlanEnd, setRootPlanEnd] = useState("");
  const [rootBusy, setRootBusy] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const {
    config: colConfig,
    visibleOrdered,
    setVisible,
    moveKey,
    setWidth,
    resetDefaults,
  } = useRequirementTreeColumns();
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const columnPanelRef = useRef<HTMLDivElement | null>(null);
  const columnSortMenuRef = useRef<HTMLDivElement | null>(null);

  /** 默认：WBS 编号升序（自然序 1 < 1.1 < 2） */
  const [sortState, setSortState] = useState<{
    key: RequirementSortableKey;
    dir: "asc" | "desc";
  } | null>({ key: "wbsId", dir: "asc" });
  const [columnSortMenu, setColumnSortMenu] =
    useState<RequirementColumnKey | null>(null);
  const [taskProgressValueFilter, setTaskProgressValueFilter] =
    useState<TaskProgressValueFilter>({ kind: "none" });
  const [statusValueFilter, setStatusValueFilter] = useState<
    Set<RequirementStatus>
  >(new Set());
  const [planStartAtFilter, setPlanStartAtFilter] = useState<{
    from: string;
    to: string;
  }>({ from: "", to: "" });
  const [planEndAtFilter, setPlanEndAtFilter] = useState<{
    from: string;
    to: string;
  }>({ from: "", to: "" });
  const [priorityValueFilter, setPriorityValueFilter] = useState<
    Set<"UNSET" | "HIGH" | "MEDIUM" | "LOW">
  >(new Set());
  // 列头模糊搜索：提交后才生效（Enter / 点击“确定”）
  const [devOwnerHeaderQDraft, setDevOwnerHeaderQDraft] = useState("");
  const [devOwnerHeaderQ, setDevOwnerHeaderQ] = useState("");

  const setSort = useCallback((key: RequirementSortableKey, dir: "asc" | "desc") => {
    setSortState({ key, dir });
  }, []);

  const clearColumnSortAndFilter = useCallback((key: RequirementColumnKey) => {
    if (isSortableRequirementColumn(key)) {
      setSortState((prev) => (prev?.key === key ? null : prev));
    }
    if (key === "taskProgress") setTaskProgressValueFilter({ kind: "none" });
    if (key === "status") setStatusValueFilter(new Set());
    if (key === "planStartAt") setPlanStartAtFilter({ from: "", to: "" });
    if (key === "planEndAt") setPlanEndAtFilter({ from: "", to: "" });
    if (key === "priority") setPriorityValueFilter(new Set());
    if (key === "devOwner") {
      setDevOwnerHeaderQDraft("");
      setDevOwnerHeaderQ("");
    }
  }, []);

  const DEFAULT_ADV_FILTER = useMemo(
    () => ({
      titleContains: "",
      status: "" as RequirementStatus | "",
      priorityText: "",
      submitter: "",
      devOwner: "",
      testOwner: "",
      createdFrom: "",
      createdTo: "",
      updatedFrom: "",
      updatedTo: "",
    }),
    [],
  );
  const [advFilter, setAdvFilter] = useState({ ...DEFAULT_ADV_FILTER });
  const [advFilterOpen, setAdvFilterOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchWorking, setBatchWorking] = useState(false);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveTargetId, setMoveTargetId] = useState<string>("__root__");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rowErr, setRowErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!iterationId) {
      setFlat([]);
      return;
    }
    setLoading(true);
    setRowErr(null);
    try {
      const data = await listRequirementsFlat(iterationId);
      setFlat(data);
      setSelectedIds([]);
    } catch (err) {
      setFlat([]);
      setSelectedIds([]);
      setRowErr(
        err instanceof Error
          ? err.message
          : "加载需求列表失败，请稍后重试。",
      );
    } finally {
      setLoading(false);
    }
  }, [iterationId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const patchRowFields = useCallback(
    async (
      id: string,
      fields: {
        priority?: number | null;
        status?: RequirementStatus;
        taskProgress?: string | null;
        latestProgress?: string | null;
      },
    ) => {
      setRowErr(null);
      const r = await patchRequirementRowFields({ id, ...fields });
      if (r.error) {
        setRowErr(r.error);
        void reload();
        return;
      }
      setFlat((prev) =>
        prev.map((row) => {
          if (row.id !== id) return row;
          const derived =
            fields.taskProgress !== undefined
              ? deriveRequirementStatusFromTaskProgress(fields.taskProgress)
              : null;
          return {
            ...row,
            ...(fields.priority !== undefined
              ? { priority: fields.priority }
              : {}),
            ...(fields.status !== undefined ? { status: fields.status } : {}),
            ...(fields.taskProgress !== undefined
              ? { taskProgress: fields.taskProgress }
              : {}),
            ...(fields.latestProgress !== undefined
              ? { latestProgress: fields.latestProgress }
              : {}),
            ...(derived !== null ? { status: derived } : {}),
          };
        }),
      );
    },
    [reload],
  );

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!columnPanelOpen) return;
      const el = columnPanelRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setColumnPanelOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [columnPanelOpen]);

  useEffect(() => {
    if (columnSortMenu === null) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (columnSortMenu !== null && columnSortMenuRef.current?.contains(t))
        return;
      setColumnSortMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [columnSortMenu]);

  const filteredFlat = useMemo(() => {
    const f = advFilter;
    const createdFromMs = toMsAtBoundary(f.createdFrom, false);
    const createdToMs = toMsAtBoundary(f.createdTo, true);
    const updatedFromMs = toMsAtBoundary(f.updatedFrom, false);
    const updatedToMs = toMsAtBoundary(f.updatedTo, true);
    const psFromMs = toMsAtBoundary(planStartAtFilter.from, false);
    const psToMs = toMsAtBoundary(planStartAtFilter.to, true);
    const peFromMs = toMsAtBoundary(planEndAtFilter.from, false);
    const peToMs = toMsAtBoundary(planEndAtFilter.to, true);

    const priFilter =
      f.priorityText.trim() === ""
        ? null
        : Number.parseInt(f.priorityText, 10);
    const priFilterNorm =
      priFilter !== null && !Number.isNaN(priFilter) ? priFilter : null;

    const rowMatch = (r: RequirementFlat) => {
      if (!matchesText(r.title, f.titleContains)) return false;
      if (!taskProgressPassesValueFilter(r.taskProgress, taskProgressValueFilter))
        return false;
      if (statusValueFilter.size > 0 && !statusValueFilter.has(r.status))
        return false;
      if (!matchesText(r.devOwner, devOwnerHeaderQ)) return false;
      if (priorityValueFilter.size > 0) {
        const pri = r.priority ?? null;
        const bucket: "UNSET" | "HIGH" | "MEDIUM" | "LOW" =
          pri === null
            ? "UNSET"
            : pri >= 3
              ? "HIGH"
              : pri === 2
                ? "MEDIUM"
                : "LOW";
        if (!priorityValueFilter.has(bucket)) return false;
      }
      if (f.status && r.status !== f.status) return false;
      if (priFilterNorm !== null && (r.priority ?? null) !== priFilterNorm)
        return false;
      if (!matchesText(r.submitter, f.submitter)) return false;
      if (!matchesText(r.devOwner, f.devOwner)) return false;
      if (!matchesText(r.testOwner, f.testOwner)) return false;
      if (!inDateRange(r.planStartAt, psFromMs, psToMs)) return false;
      if (!inDateRange(r.planEndAt, peFromMs, peToMs)) return false;
      if (!inDateRange(r.createdAt, createdFromMs, createdToMs)) return false;
      if (!inDateRange(r.updatedAt, updatedFromMs, updatedToMs)) return false;
      return true;
    };

    const byId = new Map(flat.map((r) => [r.id, r]));
    const children = new Map<string | null, string[]>();
    for (const r of flat) {
      const k = r.parentId ?? null;
      const arr = children.get(k) ?? [];
      arr.push(r.id);
      children.set(k, arr);
    }

    const keep = new Set<string>();
    const dfs = (id: string): boolean => {
      const r = byId.get(id);
      if (!r) return false;
      let ok = rowMatch(r);
      for (const cid of children.get(id) ?? []) {
        ok = dfs(cid) || ok;
      }
      if (ok) keep.add(id);
      return ok;
    };
    for (const id of children.get(null) ?? []) dfs(id);
    return flat.filter((r) => keep.has(r.id));
  }, [
    advFilter,
    devOwnerHeaderQ,
    flat,
    planEndAtFilter.from,
    planEndAtFilter.to,
    planStartAtFilter.from,
    planStartAtFilter.to,
    priorityValueFilter,
    statusValueFilter,
    taskProgressValueFilter,
  ]);

  const tree = useMemo(() => buildTree(filteredFlat), [filteredFlat]);
  const sortedTree = useMemo(
    () => sortRequirementTreeNodes(tree, sortState ? [sortState] : []),
    [tree, sortState],
  );

  // 树形按“可见行”分页：严格限制每页行数（展开子节点也计入行数）
  const visibleRows = useMemo(() => {
    const out: Array<{ n: Node; depth: number }> = [];
    const walk = (nodes: Node[], depth: number) => {
      for (const n of nodes) {
        out.push({ n, depth });
        const open = expanded[n.id] ?? true;
        if (n.children.length > 0 && open) walk(n.children, depth + 1);
      }
    };
    walk(sortedTree, 0);
    return out;
  }, [expanded, sortedTree]);
  const reqPager = usePagination(visibleRows, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.requirements",
  });
  const pagedRows = reqPager.pagedItems;
  const pagedVisibleIds = useMemo(() => pagedRows.map((x) => x.n.id), [pagedRows]);

  const focusScrollDoneRef = useRef<string | null>(null);
  useEffect(() => {
    focusScrollDoneRef.current = null;
  }, [initialFocusNodeId]);

  /** 从详情返回：展开焦点节点全部祖先，便于出现在 visibleRows 中 */
  useEffect(() => {
    if (loading) return;
    const fid = initialFocusNodeId?.trim();
    if (!fid || !iterationId) return;
    if (!flat.some((r) => r.id === fid)) return;
    const byId = new Map(flat.map((r) => [r.id, r]));
    const toOpen: Record<string, boolean> = {};
    let cur: string | null = fid;
    let guard = 0;
    while (cur && guard++ < 500) {
      toOpen[cur] = true;
      const row = byId.get(cur);
      cur = row?.parentId ?? null;
    }
    setExpanded((prev) => ({ ...prev, ...toOpen }));
  }, [loading, flat, iterationId, initialFocusNodeId]);

  /** 翻到包含该行的分页并滚动到视口 */
  useLayoutEffect(() => {
    if (loading) return;
    const fid = initialFocusNodeId?.trim();
    if (!fid) return;
    const idx = visibleRows.findIndex((x) => x.n.id === fid);
    if (idx < 0) return;
    const ps = reqPager.pageSize;
    const targetPage = Math.floor(idx / ps) + 1;
    if (reqPager.page !== targetPage) {
      reqPager.setPage(targetPage);
      return;
    }
    if (focusScrollDoneRef.current === fid) return;
    focusScrollDoneRef.current = fid;
    const safeId = fid.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document
          .querySelector(`[data-requirement-row-id="${safeId}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
  }, [
    loading,
    initialFocusNodeId,
    visibleRows,
    reqPager.page,
    reqPager.pageSize,
    reqPager.setPage,
  ]);

  const visibleNodeIds = useMemo(() => new Set(filteredFlat.map((r) => r.id)), [
    filteredFlat,
  ]);

  useEffect(() => {
    // 初始化展开状态：默认展开所有可见根节点
    setExpanded((prev) => {
      const next = { ...prev };
      for (const r of filteredFlat) {
        if (!r.parentId && next[r.id] === undefined) next[r.id] = true;
      }
      // 清理不再可见的 key，避免无限增长
      for (const k of Object.keys(next)) {
        if (!visibleNodeIds.has(k)) delete next[k];
      }
      return next;
    });
  }, [filteredFlat, visibleNodeIds]);

  const iterationLabel = useMemo(() => {
    const it = visibleIterations.find((x) => x.id === iterationId);
    return it?.label ?? "未选择";
  }, [visibleIterations, iterationId]);

  const onStartResize = useCallback(
    (key: RequirementColumnKey, startX: number) => {
      const startW = colConfig.widths[key];
      const onMove = (e: MouseEvent) => {
        const dx = e.clientX - startX;
        setWidth(key, startW + dx);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [colConfig.widths, setWidth],
  );

  const openCreateRootModal = () => {
    if (!iterationId) return;
    setRootErr(null);
    setRootTitle("");
    setRootPriority("");
    setRootStatus("UNASSIGNED");
    setRootSubmitter("");
    setRootDevOwner("");
    setRootTestOwner("");
    setRootDescription(DEFAULT_REQUIREMENT_DESCRIPTION_TEMPLATE);
    setRootPlanStart("");
    setRootPlanEnd("");
    setCreateModalOpen(true);
  };

  const submitCreateRoot = async () => {
    if (!iterationId) return;
    setRootBusy(true);
    setRootErr(null);
    const pri =
      rootPriority.trim() === "" ? null : Number.parseInt(rootPriority, 10);
    const r = await createRequirementNode({
      iterationId,
      parentId: null,
      title: rootTitle,
      priority: pri !== null && Number.isNaN(pri) ? null : pri,
      status: rootStatus,
      submitter: rootSubmitter.trim() || null,
      devOwner: rootDevOwner.trim() || null,
      testOwner: rootTestOwner.trim() || null,
      description: rootDescription.trim() || null,
      planStartAt: datetimeLocalToIsoOrNull(rootPlanStart),
      planEndAt: datetimeLocalToIsoOrNull(rootPlanEnd),
    });
    setRootBusy(false);
    if (r.error) {
      setRootErr(r.error);
      return;
    }
    setCreateModalOpen(false);
    reload();
  };

  const clearSelection = useCallback(() => setSelectedIds([]), []);

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    if (selectedIds.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const allIds = pagedVisibleIds;
    const selectedSet = new Set(selectedIds);
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedSet.has(id));
    el.indeterminate = !allSelected;
    el.checked = allSelected;
  }, [pagedVisibleIds, selectedIds]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((p) => ({ ...p, [id]: !(p[id] ?? true) }));
  }, []);

  const toggleSelectOne = useCallback((id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  const toggleSelectAll = useCallback(() => {
    const allIds = pagedVisibleIds;
    if (allIds.length === 0) return;
    setSelectedIds((prev) => {
      const selectedSet = new Set(prev);
      const allSelected = allIds.every((id) => selectedSet.has(id));
      return allSelected
        ? prev.filter((id) => !new Set(allIds).has(id))
        : Array.from(new Set([...prev, ...allIds]));
    });
  }, [pagedVisibleIds]);

  const runDuplicateAsChild = useCallback(
    async (id: string) => {
      setRowErr(null);
      const r = await duplicateRequirementAsChild(id);
      if (r.error) {
        setRowErr(r.error);
        return;
      }
      // 确保父节点展开，便于看到新子节点
      setExpanded((p) => ({ ...p, [id]: true }));
      reload();
    },
    [reload],
  );

  const runBatchDelete = useCallback(async () => {
    if (selectedIds.length === 0) return;
    if (
      !window.confirm(
        `确定批量删除已选 ${selectedIds.length} 条需求（含其所有子节点）？`,
      )
    )
      return;
    setBatchWorking(true);
    const r = await bulkDeleteRequirements({ iterationId, ids: selectedIds });
    setBatchWorking(false);
    if (r.error) {
      setRowErr(r.error);
      return;
    }
    clearSelection();
    reload();
  }, [clearSelection, iterationId, reload, selectedIds]);

  const runBatchMove = useCallback(async () => {
    if (selectedIds.length === 0) return;
    const targetParentId = moveTargetId === "__root__" ? null : moveTargetId;
    setBatchWorking(true);
    const r = await bulkMoveRequirements({
      iterationId,
      ids: selectedIds,
      targetParentId,
    });
    setBatchWorking(false);
    if (r.error) {
      setRowErr(r.error);
      return;
    }
    setMoveModalOpen(false);
    clearSelection();
    reload();
  }, [clearSelection, iterationId, moveTargetId, reload, selectedIds]);

  const downloadRequirementExcel = useCallback(
    (rows: RequirementExportRow[], filename: string) => {
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "需求");
      const buf = XLSX.write(wb, {
        bookType: "xlsx",
        type: "array",
        bookSST: false,
      });
      const blob = new Blob([buf], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const a = document.createElement("a");
      const name = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    [],
  );

  const runBatchExport = useCallback(async () => {
    if (selectedIds.length === 0) return;
    setBatchWorking(true);
    const r = await getRequirementsExportRows(selectedIds);
    setBatchWorking(false);
    if (r.error || !r.rows) {
      setRowErr(r.error ?? "导出失败，请稍后重试。");
      return;
    }
    downloadRequirementExcel(
      r.rows,
      `需求导出_已选${selectedIds.length}条_${new Date().toISOString().slice(0, 10)}.xlsx`,
    );
  }, [downloadRequirementExcel, selectedIds]);

  const runExportIteration = useCallback(async () => {
    if (!iterationId) return;
    setBatchWorking(true);
    const r = await getRequirementsExportAllForIteration(iterationId);
    setBatchWorking(false);
    if (r.error || !r.rows) {
      setRowErr(r.error ?? "导出失败，请稍后重试。");
      return;
    }
    downloadRequirementExcel(
      r.rows,
      `需求导出_当前迭代全量_${new Date().toISOString().slice(0, 10)}.xlsx`,
    );
  }, [downloadRequirementExcel, iterationId]);

  const onImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !iterationId) return;
      setRowErr(null);
      const lower = file.name.toLowerCase();
      let parsed: ImportRequirementRow[] | { error: string };
      try {
        if (lower.endsWith(".csv")) {
          parsed = parseRequirementImportCsv(await file.text());
        } else {
          parsed = parseRequirementImportExcel(await file.arrayBuffer());
        }
      } catch {
        setRowErr("无法读取文件。");
        return;
      }
      if ("error" in parsed) {
        setRowErr(parsed.error);
        return;
      }
      if (
        !window.confirm(
          `确定将 ${parsed.length} 行导入到当前迭代「${iterationLabel}」？若某行填写了 data_id 且与已有需求一致，将更新该条；其余行将新建。`,
        )
      ) {
        return;
      }
      setBatchWorking(true);
      const r = await importRequirementsCsv(iterationId, parsed);
      setBatchWorking(false);
      if (r.error) {
        setRowErr(r.error);
        return;
      }
      void reload();
    },
    [iterationId, iterationLabel, reload],
  );

  const optionTree = useMemo(() => buildTree(flat), [flat]);
  const moveOptions = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    const walk = (nodes: Node[], depth: number) => {
      for (const n of nodes) {
        out.push({
          id: n.id,
          label: `${"└─".repeat(depth)} ${n.title}`.trim(),
        });
        if (n.children.length > 0) walk(n.children, depth + 1);
      }
    };
    walk(optionTree, 0);
    return out;
  }, [optionTree]);

  const renderRow = (n: Node, depth: number): React.ReactNode => {
    const isExpanded = expanded[n.id] ?? true;
    const hasChildren = n.children.length > 0;
    const rowSurface = requirementRowSurfaceClass(
      n.status,
      n.planEndAt,
      Date.now(),
    );
    return (
      <tr
        key={n.id}
        data-requirement-row-id={n.id}
        className={[
          "group cursor-pointer border-b border-zinc-100",
          rowSurface || "hover:bg-zinc-50/70",
        ].join(" ")}
        onClick={() => router.push(`/requirements/node/${n.id}`)}
      >
        <td className="w-12 py-2.5 pl-3 pr-2 align-top">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-zinc-300"
            checked={selectedIds.includes(n.id)}
            onChange={(e) => {
              e.stopPropagation();
              toggleSelectOne(n.id);
            }}
            aria-label={`选择需求：${n.title}`}
            onClick={(e) => e.stopPropagation()}
          />
        </td>
        {visibleOrdered.map((k) => {
          const w = colConfig.widths[k];
          if (k === "title") {
            return (
              <td
                key={k}
                className="max-w-0 overflow-hidden py-2.5 pr-2 align-top"
                style={{ width: w, minWidth: w }}
              >
                <div
                  className="flex min-w-0 items-start gap-2"
                  style={{ paddingLeft: depth * 14 + 8 }}
                >
                  <button
                    type="button"
                    className={[
                      "mt-0.5 h-5 w-5 shrink-0 rounded text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700",
                      hasChildren ? "visible" : "invisible",
                    ].join(" ")}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(n.id);
                    }}
                    aria-label={isExpanded ? "收起" : "展开"}
                    title={isExpanded ? "收起" : "展开"}
                  >
                    {isExpanded ? "▾" : "▸"}
                  </button>
                  <button
                    type="button"
                    className="mt-0.5 h-5 w-5 shrink-0 rounded border border-zinc-200 bg-white text-xs text-zinc-700 opacity-0 transition hover:bg-zinc-50 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      void runDuplicateAsChild(n.id);
                    }}
                    aria-label="复制为子节点"
                    title="复制为子节点（复制父节点全部数据）"
                  >
                    +
                  </button>
                  <Link
                    href={`/requirements/node/${n.id}`}
                    className="min-w-0 flex-1 underline-offset-2 hover:underline"
                    title={n.title}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {requirementCell(n, "title")}
                  </Link>
                </div>
              </td>
            );
          }
          if (k === "priority") {
            return (
              <td
                key={k}
                className="max-w-0 overflow-hidden py-2.5 pr-2 align-top"
                style={{ width: w, minWidth: w }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <RequirementPrioritySelect
                  value={
                    n.priority === null || n.priority === undefined
                      ? ""
                      : String(n.priority)
                  }
                  onChange={(v) => {
                    const pri =
                      v.trim() === ""
                        ? null
                        : Number.parseInt(v.trim(), 10);
                    void patchRowFields(n.id, {
                      priority:
                        pri === null || Number.isNaN(pri) ? null : pri,
                    });
                  }}
                  className="max-w-full"
                />
              </td>
            );
          }
          if (k === "status") {
            return (
              <td
                key={k}
                className="max-w-0 overflow-hidden py-2.5 pr-2 align-top"
                style={{ width: w, minWidth: w }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <select
                  value={n.status}
                  onChange={(e) => {
                    void patchRowFields(n.id, {
                      status: e.target.value as RequirementStatus,
                    });
                  }}
                  className={[
                    "max-w-full rounded-full border px-2 py-0.5 text-xs font-medium outline-none",
                    requirementStatusBadgeClass[n.status],
                  ].join(" ")}
                  aria-label={`需求状态：${n.title}`}
                >
                  {(
                    Object.keys(requirementStatusLabel) as RequirementStatus[]
                  ).map((s) => (
                    <option key={s} value={s}>
                      {requirementStatusLabel[s]}
                    </option>
                  ))}
                </select>
              </td>
            );
          }
          if (k === "taskProgress") {
            const rawTp = (n.taskProgress ?? "").trim();
            const pctTp = rawTp ? parseTaskProgressPercent(rawTp) : null;
            const tpCls =
              pctTp !== null
                ? `inline-flex w-full min-w-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums outline-none focus:ring-2 focus:ring-zinc-300 ${taskProgressPercentPillClass(pctTp)}`
                : "w-full min-w-0 rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 outline-none focus:ring-2 focus:ring-zinc-300";
            return (
              <td
                key={k}
                className="max-w-0 overflow-hidden py-2.5 pr-2 align-top"
                style={{ width: w, minWidth: w }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  key={`tp-${n.id}-${n.taskProgress ?? ""}`}
                  type="text"
                  defaultValue={formatTaskProgressAsPercentIfNumeric(
                    n.taskProgress ?? "",
                  )}
                  placeholder="如 0.1→10%、30→30%"
                  onBlur={(e) => {
                    const vIn = e.target.value.trim();
                    if (vIn === "") {
                      const cur = (n.taskProgress ?? "").trim() || null;
                      if (cur !== null)
                        void patchRowFields(n.id, { taskProgress: null });
                      return;
                    }
                    const formatted = formatTaskProgressAsPercentIfNumeric(vIn);
                    e.target.value = formatted;
                    const rawStored = (n.taskProgress ?? "").trim();
                    if (formatted !== rawStored)
                      void patchRowFields(n.id, { taskProgress: formatted });
                  }}
                  className={tpCls}
                  aria-label={`任务进度：${n.title}`}
                />
              </td>
            );
          }
          if (k === "latestProgress") {
            return (
              <td
                key={k}
                className="max-w-0 overflow-hidden py-2.5 pr-2 align-top"
                style={{ width: w, minWidth: w }}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >
                <textarea
                  key={`lp-${n.id}-${n.latestProgress ?? ""}`}
                  rows={2}
                  defaultValue={n.latestProgress ?? ""}
                  placeholder="最新进展情况"
                  title={
                    (n.latestProgress ?? "").trim()
                      ? (n.latestProgress ?? "")
                      : undefined
                  }
                  onBlur={(e) => {
                    const v = e.target.value.trim() || null;
                    const cur = (n.latestProgress ?? "").trim() || null;
                    if (v !== cur)
                      void patchRowFields(n.id, { latestProgress: v });
                  }}
                  className="w-full min-w-0 resize-y rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-800 outline-none focus:ring-2 focus:ring-zinc-300"
                  aria-label={`最新进展：${n.title}`}
                />
              </td>
            );
          }
          return (
            <td
              key={k}
              className="max-w-0 overflow-hidden py-2.5 pr-2 align-top"
              style={{ width: w, minWidth: w }}
            >
              {requirementCell(n, k)}
            </td>
          );
        })}
      </tr>
    );
  };

  return (
    <>
      <ModuleWorkspaceCard>
        <div className="flex max-h-[calc(100dvh-11rem)] min-h-[70vh] flex-col overflow-hidden">
          <div className="shrink-0 border-b border-zinc-200 bg-zinc-50/60 px-3 py-2 sm:px-4">
            <div className="flex flex-wrap items-end gap-3 gap-y-2">
              <div className="min-w-[min(100%,12rem)] flex-1 sm:flex-initial sm:min-w-[220px]">
                <label className="text-xs font-medium text-zinc-600">
                  所属产品
                </label>
                <select
                  className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                >
                  {products.length === 0 ? (
                    <option value="">暂无产品，请先在「产品管理」中创建</option>
                  ) : (
                    products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code ? `${p.name}（${p.code}）` : p.name}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="min-w-[min(100%,12rem)] flex-1 sm:flex-initial sm:min-w-[220px]">
                <label className="text-xs font-medium text-zinc-600">
                  所属迭代
                </label>
                <select
                  className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm"
                  value={iterationId}
                  onChange={(e) => setIterationId(e.target.value)}
                >
                  {visibleIterations.length === 0 ? (
                    <option value="">暂无迭代，请先在「产品管理」中创建</option>
                  ) : (
                    visibleIterations.map((it) => (
                      <option key={it.id} value={it.id}>
                        {it.label}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <p className="hidden max-w-xl pb-0.5 text-[11px] leading-snug text-zinc-500 sm:block">
                先选择<strong>所属迭代</strong>，再在下方表格维护需求树；点击任务名称进入详情。
              </p>
            </div>
            {!iterationId ? (
              <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                没有可选迭代时，请先创建产品与迭代。
              </p>
            ) : null}
          </div>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
            <div className="border-b border-zinc-100 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">
                    当前：{iterationLabel}
                  </h2>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    表格包含当前迭代下全部需求；点击任务名称进入详情；右侧⚙可配置列显隐/顺序；表头 ⇅
                    仅提供升序/降序与条件筛选；表头竖线可拖动调宽。
                  </p>
                </div>
                <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setAdvFilterOpen((o) => !o)}
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    aria-expanded={advFilterOpen}
                  >
                    <span>高级筛选</span>{" "}
                    <span className="ml-1 text-xs text-zinc-500">
                      {advFilterOpen ? "▼" : "▶"}
                    </span>
                  </button>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,.csv,text/csv"
                    className="hidden"
                    onChange={onImportFile}
                    aria-hidden
                  />
                  <button
                    type="button"
                    disabled={!iterationId || batchWorking}
                    title="从 Excel（.xlsx/.xls）导入需求；仍可选择旧版 CSV。将按表头解析并新建节点。"
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    onClick={() => importFileRef.current?.click()}
                  >
                    导入 Excel
                  </button>
                  <button
                    type="button"
                    disabled={!iterationId || batchWorking}
                    title="导出当前迭代全部需求为 Excel（.xlsx，含节点/父节点 ID 列，便于再导入）"
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    onClick={() => void runExportIteration()}
                  >
                    导出全量 Excel
                  </button>
                  <div className="relative" ref={columnPanelRef}>
                    <button
                      type="button"
                      onClick={() => setColumnPanelOpen((p) => !p)}
                      className={MODULE_TOOLBAR_BTN_SECONDARY}
                      title="列表列设置（显隐、顺序；表头可拖竖线调宽）"
                      aria-expanded={columnPanelOpen}
                      aria-haspopup="true"
                      aria-label="需求列表列设置"
                    >
                      ⚙
                    </button>
                    {columnPanelOpen ? (
                      <div
                        className="absolute right-0 top-full z-[150] mt-1.5 w-80 max-h-[min(70vh,28rem)] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 text-left shadow-xl"
                        role="dialog"
                        aria-label="列设置"
                      >
                        <p className="text-xs leading-relaxed text-zinc-500">
                          勾选表示在表格中显示。使用上下箭头调整列的先后顺序。在表头列右侧的竖线上按住拖动可调整列宽。
                        </p>
                        <ul className="mt-3 space-y-1">
                          {colConfig.order.map((key, idx) => (
                            <li
                              key={key}
                              className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-zinc-50"
                            >
                              <input
                                id={`req-col-vis-${key}`}
                                type="checkbox"
                                className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                checked={colConfig.visible[key] !== false}
                                onChange={(e) =>
                                  setVisible(key, e.target.checked)
                                }
                              />
                              <label
                                htmlFor={`req-col-vis-${key}`}
                                className="min-w-0 flex-1 cursor-pointer text-sm text-zinc-800"
                              >
                                {REQUIREMENT_COLUMN_LABELS[key]}
                              </label>
                              <div className="flex shrink-0 gap-0.5">
                                <button
                                  type="button"
                                  className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 disabled:opacity-30"
                                  disabled={idx === 0}
                                  title="上移"
                                  onClick={() => moveKey(key, -1)}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 disabled:opacity-30"
                                  disabled={idx === colConfig.order.length - 1}
                                  title="下移"
                                  onClick={() => moveKey(key, 1)}
                                >
                                  ↓
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                        <button
                          type="button"
                          className="mt-3 w-full rounded-lg border border-zinc-200 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                          onClick={() => resetDefaults()}
                        >
                          恢复默认列
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={!iterationId}
                    onClick={openCreateRootModal}
                    className={MODULE_TOOLBAR_BTN_PRIMARY}
                  >
                    + 新建需求
                  </button>
                </div>
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
              {!iterationId ? (
                <p className="text-sm text-zinc-500">
                  请先在上方选择所属迭代。
                </p>
              ) : (
                <>
                {selectedIds.length > 0 ? (
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/90 px-3 py-2.5 text-sm text-zinc-800">
                    <span>
                      已选{" "}
                      <strong className="tabular-nums">{selectedIds.length}</strong>{" "}
                      条
                    </span>
                    <span className="hidden text-zinc-400 sm:inline">|</span>
                    <button
                      type="button"
                      disabled={batchWorking}
                      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                      onClick={runBatchExport}
                    >
                      批量导出 Excel
                    </button>
                    <button
                      type="button"
                      disabled={batchWorking}
                      className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                      onClick={() => {
                        setMoveTargetId("__root__");
                        setMoveModalOpen(true);
                      }}
                    >
                      批量移动
                    </button>
                    <button
                      type="button"
                      disabled={batchWorking}
                      className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                      onClick={runBatchDelete}
                    >
                      批量删除
                    </button>
                    <button
                      type="button"
                      className="ml-auto text-xs text-zinc-500 underline hover:text-zinc-800"
                      onClick={clearSelection}
                    >
                      取消选择
                    </button>
                  </div>
                ) : null}

                {advFilterOpen ? (
                  <div className="mb-3 rounded-lg border border-zinc-200 bg-white p-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          任务名称包含
                        </label>
                        <input
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.titleContains}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              titleContains: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          状态
                        </label>
                        <select
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.status}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              status: e.target.value as RequirementStatus | "",
                            }))
                          }
                        >
                          <option value="">全部</option>
                          {(
                            Object.keys(requirementStatusLabel) as RequirementStatus[]
                          ).map((s) => (
                            <option key={s} value={s}>
                              {requirementStatusLabel[s]}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          优先级
                        </label>
                        <select
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.priorityText}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              priorityText: e.target.value,
                            }))
                          }
                        >
                          <option value="">全部</option>
                          <option value="3">高</option>
                          <option value="2">中</option>
                          <option value="1">低</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          提交人包含
                        </label>
                        <input
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.submitter}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              submitter: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          开发负责人包含
                        </label>
                        <input
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.devOwner}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              devOwner: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          测试负责人包含
                        </label>
                        <input
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.testOwner}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              testOwner: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          创建时间从
                        </label>
                        <input
                          type="date"
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.createdFrom}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              createdFrom: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          创建时间到
                        </label>
                        <input
                          type="date"
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.createdTo}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              createdTo: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          更新时间从
                        </label>
                        <input
                          type="date"
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.updatedFrom}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              updatedFrom: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          更新时间到
                        </label>
                        <input
                          type="date"
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                          value={advFilter.updatedTo}
                          onChange={(e) =>
                            setAdvFilter((p) => ({
                              ...p,
                              updatedTo: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                        onClick={() => setAdvFilter({ ...DEFAULT_ADV_FILTER })}
                      >
                        重置筛选
                      </button>
                    </div>
                  </div>
                ) : null}

                {rowErr && (
                  <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                    {rowErr}
                  </div>
                )}

                {loading ? (
                  <p className="text-sm text-zinc-500">加载中…</p>
                ) : sortedTree.length === 0 ? (
                  <p className="text-sm text-zinc-500">
                    {flat.length === 0
                      ? "暂无需求，请先新建需求。"
                      : "没有符合当前筛选条件的需求。可尝试重置高级筛选。"}
                  </p>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-zinc-200 bg-white">
                      <table className="min-w-[960px] table-fixed">
                        <thead className="sticky top-0 z-20 border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500 shadow-[0_1px_0_0_rgb(228_228_231)]">
                          <tr>
                            <th className="w-12 py-2.5 pl-3 pr-2 text-left align-bottom font-medium">
                              <input
                                ref={selectAllRef}
                                type="checkbox"
                                className="h-4 w-4 rounded border-zinc-300"
                                onChange={toggleSelectAll}
                                aria-label="全选"
                              />
                            </th>
                          {visibleOrdered.map((k) => {
                            const w = colConfig.widths[k];
                            const sortable =
                              k !== "title" && isSortableRequirementColumn(k);
                            const filterable =
                              k === "priority" ||
                              k === "status" ||
                              k === "taskProgress" ||
                              k === "planStartAt" ||
                              k === "planEndAt" ||
                              k === "devOwner";
                            const sortBadge =
                              sortState?.key === k
                                ? sortState.dir === "asc"
                                  ? "↑"
                                  : "↓"
                                : "";
                            return (
                              <th
                                key={k}
                                className="relative select-none py-2.5 pr-2 text-left align-bottom font-medium"
                                style={{ width: w, minWidth: w }}
                              >
                                <div
                                  className={[
                                    "flex min-w-0 items-end gap-0.5",
                                    k === "title" ? "pr-1" : "justify-between pr-3",
                                  ].join(" ")}
                                >
                                  {k === "title" ? (
                                    <div className="flex min-w-0 flex-1 items-start gap-2 pl-2">
                                      <span
                                        className="mt-0.5 h-5 w-5 shrink-0"
                                        aria-hidden
                                      />
                                      <span
                                        className="mt-0.5 h-5 w-5 shrink-0"
                                        aria-hidden
                                      />
                                      <span className="min-w-0 flex-1 truncate">
                                        {REQUIREMENT_COLUMN_LABELS[k]}
                                      </span>
                                    </div>
                                  ) : (
                                    <>
                                      <div className="min-w-0 flex-1 pr-1">
                                        <span className="block truncate">
                                          {REQUIREMENT_COLUMN_LABELS[k]}
                                        </span>
                                      </div>
                                      {sortable || filterable ? (
                                        <div
                                          className="relative shrink-0"
                                          ref={
                                            columnSortMenu === k
                                              ? columnSortMenuRef
                                              : undefined
                                          }
                                        >
                                          <button
                                            type="button"
                                            className={[
                                              "rounded px-0.5 py-0.5 text-sm leading-none text-zinc-400 hover:bg-zinc-200 hover:text-zinc-800",
                                              sortBadge ? "text-zinc-700" : "",
                                            ].join(" ")}
                                            title="排序与筛选"
                                            aria-label={`${REQUIREMENT_COLUMN_LABELS[k]}：排序`}
                                            aria-expanded={columnSortMenu === k}
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setColumnSortMenu((m) =>
                                                m === k ? null : k,
                                              );
                                            }}
                                          >
                                            ⇅
                                            {sortBadge ? (
                                              <span className="ml-0.5 align-middle text-[10px] tabular-nums">
                                                {sortBadge}
                                              </span>
                                            ) : null}
                                          </button>
                                          {columnSortMenu === k ? (
                                            <div
                                              className="absolute right-0 top-full z-[160] mt-1 w-56 rounded-lg border border-zinc-200 bg-white py-1.5 shadow-lg"
                                              role="menu"
                                            >
                                              {sortable ? (
                                                <>
                                                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                                                    排序
                                                  </div>
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="block w-full px-3 py-1.5 text-left text-xs hover:bg-zinc-100"
                                                    onClick={() => {
                                                      setSort(k, "asc");
                                                      setColumnSortMenu(null);
                                                    }}
                                                  >
                                                    升序
                                                  </button>
                                                  <button
                                                    type="button"
                                                    role="menuitem"
                                                    className="block w-full px-3 py-1.5 text-left text-xs hover:bg-zinc-100"
                                                    onClick={() => {
                                                      setSort(k, "desc");
                                                      setColumnSortMenu(null);
                                                    }}
                                                  >
                                                    降序
                                                  </button>
                                                </>
                                              ) : null}
                                              <button
                                                type="button"
                                                role="menuitem"
                                                className="block w-full px-3 py-1.5 text-left text-xs text-zinc-600 hover:bg-zinc-100"
                                                onClick={() => {
                                                  clearColumnSortAndFilter(k);
                                                }}
                                              >
                                                清除本列排序/筛选
                                              </button>
                                              {k === "priority" ? (
                                                <div className="mt-1 border-t border-zinc-100 pt-1.5">
                                                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                                                    优先级筛选（可多选）
                                                  </div>
                                                  <div className="px-2 pb-1">
                                                    {(
                                                      [
                                                        {
                                                          id: "HIGH",
                                                          label: "高",
                                                          cls: "text-red-700",
                                                        },
                                                        {
                                                          id: "MEDIUM",
                                                          label: "中",
                                                          cls: "text-amber-700",
                                                        },
                                                        {
                                                          id: "LOW",
                                                          label: "低",
                                                          cls: "text-sky-700",
                                                        },
                                                        {
                                                          id: "UNSET",
                                                          label: "未设置",
                                                          cls: "text-zinc-600",
                                                        },
                                                      ] as const
                                                    ).map((opt) => (
                                                      <label
                                                        key={opt.id}
                                                        className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-zinc-50"
                                                      >
                                                        <input
                                                          type="checkbox"
                                                          className="h-3.5 w-3.5 rounded border-zinc-300"
                                                          checked={priorityValueFilter.has(
                                                            opt.id,
                                                          )}
                                                          onChange={(e) => {
                                                            const on =
                                                              e.target.checked;
                                                            setPriorityValueFilter(
                                                              (prev) => {
                                                                const next =
                                                                  new Set(prev);
                                                                if (on)
                                                                  next.add(
                                                                    opt.id,
                                                                  );
                                                                else
                                                                  next.delete(
                                                                    opt.id,
                                                                  );
                                                                return next;
                                                              },
                                                            );
                                                          }}
                                                        />
                                                        <span className={opt.cls}>
                                                          {opt.label}
                                                        </span>
                                                      </label>
                                                    ))}
                                                    {priorityValueFilter.size >
                                                    0 ? (
                                                      <button
                                                        type="button"
                                                        className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                                        onClick={() =>
                                                          setPriorityValueFilter(
                                                            new Set(),
                                                          )
                                                        }
                                                      >
                                                        清空优先级筛选
                                                      </button>
                                                    ) : null}
                                                  </div>
                                                </div>
                                              ) : null}
                                              {k === "devOwner" ? (
                                                <div className="mt-1 border-t border-zinc-100 pt-1.5">
                                                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                                                    开发负责人（模糊包含）
                                                  </div>
                                                  <div className="px-2 pb-2">
                                                    <input
                                                      type="search"
                                                      className="mt-1 w-full rounded border border-zinc-200 bg-white px-2 py-1 text-xs"
                                                      placeholder="输入关键字…"
                                                      value={devOwnerHeaderQDraft}
                                                      onChange={(e) =>
                                                        setDevOwnerHeaderQDraft(
                                                          e.target.value,
                                                        )
                                                      }
                                                      onKeyDown={(e) => {
                                                        if (e.key === "Enter") {
                                                          e.preventDefault();
                                                          setDevOwnerHeaderQ(
                                                            devOwnerHeaderQDraft,
                                                          );
                                                          setColumnSortMenu(null);
                                                        }
                                                      }}
                                                    />
                                                    <div className="mt-1 flex gap-1.5">
                                                      <button
                                                        type="button"
                                                        className="w-full rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                                                        disabled={
                                                          devOwnerHeaderQDraft.trim() ===
                                                          devOwnerHeaderQ.trim()
                                                        }
                                                        onClick={() => {
                                                          setDevOwnerHeaderQ(
                                                            devOwnerHeaderQDraft,
                                                          );
                                                          setColumnSortMenu(null);
                                                        }}
                                                      >
                                                        确定
                                                      </button>
                                                      <button
                                                        type="button"
                                                        className="w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                                                        disabled={
                                                          devOwnerHeaderQDraft.trim() ===
                                                            "" &&
                                                          devOwnerHeaderQ.trim() ===
                                                            ""
                                                        }
                                                        onClick={() => {
                                                          setDevOwnerHeaderQDraft(
                                                            "",
                                                          );
                                                          setDevOwnerHeaderQ("");
                                                        }}
                                                      >
                                                        清空
                                                      </button>
                                                    </div>
                                                  </div>
                                                </div>
                                              ) : null}
                                              {k === "status" ? (
                                                <div className="mt-1 border-t border-zinc-100 pt-1.5">
                                                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                                                    状态筛选（可多选）
                                                  </div>
                                                  <div className="px-2 pb-1">
                                                    <div className="space-y-1">
                                                      {(
                                                        Object.keys(
                                                          requirementStatusLabel,
                                                        ) as RequirementStatus[]
                                                      ).map((s) => {
                                                        const checked =
                                                          statusValueFilter.has(
                                                            s,
                                                          );
                                                        return (
                                                          <label
                                                            key={s}
                                                            className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-zinc-50"
                                                          >
                                                            <input
                                                              type="checkbox"
                                                              className="h-3.5 w-3.5 rounded border-zinc-300"
                                                              checked={checked}
                                                              onChange={(e) => {
                                                                const on =
                                                                  e.target.checked;
                                                                setStatusValueFilter(
                                                                  (prev) => {
                                                                    const next =
                                                                      new Set(
                                                                        prev,
                                                                      );
                                                                    if (on)
                                                                      next.add(
                                                                        s,
                                                                      );
                                                                    else
                                                                      next.delete(
                                                                        s,
                                                                      );
                                                                    return next;
                                                                  },
                                                                );
                                                              }}
                                                            />
                                                            <span className="text-zinc-700">
                                                              {
                                                                requirementStatusLabel[
                                                                  s
                                                                ]
                                                              }
                                                            </span>
                                                          </label>
                                                        );
                                                      })}
                                                    </div>
                                                    {statusValueFilter.size >
                                                    0 ? (
                                                      <button
                                                        type="button"
                                                        className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                                        onClick={() =>
                                                          setStatusValueFilter(
                                                            new Set(),
                                                          )
                                                        }
                                                      >
                                                        清空状态筛选
                                                      </button>
                                                    ) : null}
                                                  </div>
                                                </div>
                                              ) : null}
                                              {k === "taskProgress" ? (
                                                <div className="mt-1 border-t border-zinc-100 pt-1.5">
                                                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                                                    进度数值（可解析为 % 的行）
                                                  </div>
                                                  <div className="px-2 pb-1">
                                                    <select
                                                      className="mt-1 w-full rounded border border-zinc-200 bg-white px-1.5 py-1 text-xs"
                                                      value={
                                                        taskProgressValueFilter.kind
                                                      }
                                                      onChange={(e) => {
                                                        const v = e.target.value;
                                                        if (v === "none")
                                                          setTaskProgressValueFilter(
                                                            { kind: "none" },
                                                          );
                                                        else if (v === "eq")
                                                          setTaskProgressValueFilter(
                                                            {
                                                              kind: "eq",
                                                              v: 50,
                                                            },
                                                          );
                                                        else if (v === "gte")
                                                          setTaskProgressValueFilter(
                                                            {
                                                              kind: "gte",
                                                              v: 50,
                                                            },
                                                          );
                                                        else if (v === "lte")
                                                          setTaskProgressValueFilter(
                                                            {
                                                              kind: "lte",
                                                              v: 50,
                                                            },
                                                          );
                                                        else
                                                          setTaskProgressValueFilter(
                                                            {
                                                              kind: "between",
                                                              lo: 0,
                                                              hi: 100,
                                                            },
                                                          );
                                                      }}
                                                    >
                                                      <option value="none">
                                                        不限
                                                      </option>
                                                      <option value="eq">
                                                        等于
                                                      </option>
                                                      <option value="gte">
                                                        大于等于
                                                      </option>
                                                      <option value="lte">
                                                        小于等于
                                                      </option>
                                                      <option value="between">
                                                        介于（含边界）
                                                      </option>
                                                    </select>
                                                    {taskProgressValueFilter.kind ===
                                                    "between" ? (
                                                      <div className="mt-1 flex items-center gap-1">
                                                        <input
                                                          type="number"
                                                          className="w-full rounded border border-zinc-200 px-1 py-0.5 text-xs"
                                                          min={0}
                                                          max={100}
                                                          value={
                                                            taskProgressValueFilter.lo
                                                          }
                                                          onChange={(e) => {
                                                            const lo =
                                                              Number.parseFloat(
                                                                e.target.value,
                                                              ) || 0;
                                                            setTaskProgressValueFilter(
                                                              (p) =>
                                                                p.kind ===
                                                                "between"
                                                                  ? {
                                                                      ...p,
                                                                      lo,
                                                                    }
                                                                  : p,
                                                            );
                                                          }}
                                                        />
                                                        <span className="shrink-0 text-zinc-400">
                                                          —
                                                        </span>
                                                        <input
                                                          type="number"
                                                          className="w-full rounded border border-zinc-200 px-1 py-0.5 text-xs"
                                                          min={0}
                                                          max={100}
                                                          value={
                                                            taskProgressValueFilter.hi
                                                          }
                                                          onChange={(e) => {
                                                            const hi =
                                                              Number.parseFloat(
                                                                e.target.value,
                                                              ) || 0;
                                                            setTaskProgressValueFilter(
                                                              (p) =>
                                                                p.kind ===
                                                                "between"
                                                                  ? {
                                                                      ...p,
                                                                      hi,
                                                                    }
                                                                  : p,
                                                            );
                                                          }}
                                                        />
                                                      </div>
                                                    ) : taskProgressValueFilter.kind !==
                                                      "none" ? (
                                                      <input
                                                        type="number"
                                                        className="mt-1 w-full rounded border border-zinc-200 px-1.5 py-1 text-xs"
                                                        min={0}
                                                        max={100}
                                                        step="any"
                                                        value={
                                                          taskProgressValueFilter.kind ===
                                                            "eq" ||
                                                          taskProgressValueFilter.kind ===
                                                            "gte" ||
                                                          taskProgressValueFilter.kind ===
                                                            "lte"
                                                            ? taskProgressValueFilter.v
                                                            : 0
                                                        }
                                                        onChange={(e) => {
                                                          const n =
                                                            Number.parseFloat(
                                                              e.target.value,
                                                            );
                                                          const v =
                                                            Number.isNaN(n)
                                                              ? 0
                                                              : n;
                                                          setTaskProgressValueFilter(
                                                            (p) =>
                                                              p.kind ===
                                                                "eq" ||
                                                              p.kind ===
                                                                "gte" ||
                                                              p.kind === "lte"
                                                                ? {
                                                                    ...p,
                                                                    v,
                                                                  }
                                                                : p,
                                                          );
                                                        }}
                                                      />
                                                    ) : null}
                                                  </div>
                                                </div>
                                              ) : null}
                                              {k === "planStartAt" ? (
                                                <div className="mt-1 border-t border-zinc-100 pt-1.5">
                                                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                                                    计划开始时间（起止）
                                                  </div>
                                                  <div className="px-2 pb-2">
                                                    <div className="mt-1 grid grid-cols-2 gap-1.5">
                                                      <input
                                                        type="date"
                                                        className="w-full rounded border border-zinc-200 px-2 py-1 text-xs"
                                                        value={
                                                          planStartAtFilter.from
                                                        }
                                                        onChange={(e) =>
                                                          setPlanStartAtFilter(
                                                            (p) => ({
                                                              ...p,
                                                              from: e.target.value,
                                                            }),
                                                          )
                                                        }
                                                      />
                                                      <input
                                                        type="date"
                                                        className="w-full rounded border border-zinc-200 px-2 py-1 text-xs"
                                                        value={
                                                          planStartAtFilter.to
                                                        }
                                                        onChange={(e) =>
                                                          setPlanStartAtFilter(
                                                            (p) => ({
                                                              ...p,
                                                              to: e.target.value,
                                                            }),
                                                          )
                                                        }
                                                      />
                                                    </div>
                                                    {(planStartAtFilter.from ||
                                                      planStartAtFilter.to) && (
                                                      <button
                                                        type="button"
                                                        className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                                        onClick={() =>
                                                          setPlanStartAtFilter({
                                                            from: "",
                                                            to: "",
                                                          })
                                                        }
                                                      >
                                                        清空时间筛选
                                                      </button>
                                                    )}
                                                  </div>
                                                </div>
                                              ) : null}
                                              {k === "planEndAt" ? (
                                                <div className="mt-1 border-t border-zinc-100 pt-1.5">
                                                  <div className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
                                                    计划结束时间（起止）
                                                  </div>
                                                  <div className="px-2 pb-2">
                                                    <div className="mt-1 grid grid-cols-2 gap-1.5">
                                                      <input
                                                        type="date"
                                                        className="w-full rounded border border-zinc-200 px-2 py-1 text-xs"
                                                        value={planEndAtFilter.from}
                                                        onChange={(e) =>
                                                          setPlanEndAtFilter(
                                                            (p) => ({
                                                              ...p,
                                                              from: e.target.value,
                                                            }),
                                                          )
                                                        }
                                                      />
                                                      <input
                                                        type="date"
                                                        className="w-full rounded border border-zinc-200 px-2 py-1 text-xs"
                                                        value={planEndAtFilter.to}
                                                        onChange={(e) =>
                                                          setPlanEndAtFilter(
                                                            (p) => ({
                                                              ...p,
                                                              to: e.target.value,
                                                            }),
                                                          )
                                                        }
                                                      />
                                                    </div>
                                                    {(planEndAtFilter.from ||
                                                      planEndAtFilter.to) && (
                                                      <button
                                                        type="button"
                                                        className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                                        onClick={() =>
                                                          setPlanEndAtFilter({
                                                            from: "",
                                                            to: "",
                                                          })
                                                        }
                                                      >
                                                        清空时间筛选
                                                      </button>
                                                    )}
                                                  </div>
                                                </div>
                                              ) : null}
                                            </div>
                                          ) : null}
                                        </div>
                                      ) : null}
                                    </>
                                  )}
                                </div>
                                <span
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    onStartResize(k, e.clientX);
                                  }}
                                  className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-zinc-300/40"
                                  title="拖动调整列宽"
                                  role="separator"
                                />
                              </th>
                            );
                          })}
                        </tr>
                        </thead>
                        <tbody>
                          {pagedRows.map(({ n, depth }) => renderRow(n, depth))}
                        </tbody>
                      </table>
                    </div>
                    <div className="shrink-0">
                      <PaginationBar
                        page={reqPager.page}
                        pageCount={reqPager.pageCount}
                        pageSize={reqPager.pageSize}
                        pageSizeOptions={reqPager.pageSizeOptions}
                        rangeLabel={reqPager.rangeLabel}
                        onPageChange={reqPager.setPage}
                        onPageSizeChange={reqPager.setPageSize}
                        className="!mt-0 w-full justify-end pt-3"
                      />
                    </div>
                  </div>
                )}
              </>
            )}
            </div>
          </section>
        </div>
      </ModuleWorkspaceCard>
      {createModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal
        >
          <div className="w-full max-w-4xl rounded-2xl border border-zinc-200 bg-white shadow-xl">
            <div className="border-b border-zinc-100 px-6 py-4">
              <h3 className="text-lg font-semibold text-zinc-900">新建需求</h3>
              <p className="mt-1 text-xs text-zinc-500">
                作为当前迭代的<strong>根节点</strong>创建。可在下方填写需求描述与计划时间；<strong>附件</strong>
                仍请在保存后进入节点详情上传。
              </p>
              <div className="mt-3 max-w-[820px]">
                <input
                  className="w-full rounded-lg border border-transparent bg-transparent px-0 py-0 text-lg font-semibold text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-transparent focus:ring-0"
                  placeholder="任务名称"
                  value={rootTitle}
                  onChange={(e) => setRootTitle(e.target.value)}
                />
                <div className="mt-1 text-xs text-zinc-500">
                  修改时间：创建后自动生成（以保存时间为准）
                </div>
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                编辑任务名称、描述、优先级与团队字段；保存后出现在下方树表，并可进入详情补充附件。
              </p>
            </div>
            <div className="max-h-[min(72vh,620px)] overflow-y-auto px-6 py-4">
              <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
                <section className="rounded-xl border border-zinc-200 bg-zinc-50/40 p-4">
                  <h4 className="text-xs font-semibold text-zinc-700">
                    需求描述
                  </h4>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                    可在此填写背景、范围、验收要点等。<strong>附件</strong>请在创建后进入节点详情管理。
                  </p>
                  <textarea
                    className="mt-3 min-h-[220px] w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:ring-2 focus:ring-zinc-300"
                    placeholder="需求背景、功能说明、验收标准等（可选）"
                    value={rootDescription}
                    onChange={(e) => setRootDescription(e.target.value)}
                    rows={8}
                  />
                </section>
                <section className="min-w-0 space-y-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      优先级（高 / 中 / 低）
                    </label>
                    <RequirementPrioritySelect
                      value={rootPriority}
                      onChange={setRootPriority}
                      className="mt-1 w-full px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      需求状态
                    </label>
                    <select
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      value={rootStatus}
                      onChange={(e) =>
                        setRootStatus(e.target.value as RequirementStatus)
                      }
                    >
                      {(
                        Object.keys(requirementStatusLabel) as RequirementStatus[]
                      ).map((value) => (
                        <option key={value} value={value}>
                          {requirementStatusLabel[value]}
                        </option>
                      ))}
                    </select>
                    <div className="mt-1.5">
                      <span
                        className={[
                          "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                          requirementStatusBadgeClass[rootStatus],
                        ].join(" ")}
                      >
                        {requirementStatusLabel[rootStatus]}
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      计划开始时间
                    </label>
                    <input
                      type="datetime-local"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm tabular-nums"
                      value={rootPlanStart}
                      onChange={(e) => setRootPlanStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      计划结束时间
                    </label>
                    <input
                      type="datetime-local"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm tabular-nums"
                      value={rootPlanEnd}
                      onChange={(e) => setRootPlanEnd(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      提交人
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      placeholder="例如：张三"
                      value={rootSubmitter}
                      onChange={(e) => setRootSubmitter(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      开发负责人
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      placeholder="例如：李四"
                      value={rootDevOwner}
                      onChange={(e) => setRootDevOwner(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      测试负责人
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      placeholder="例如：王五"
                      value={rootTestOwner}
                      onChange={(e) => setRootTestOwner(e.target.value)}
                    />
                  </div>
                </section>
              </div>
              {rootErr ? (
                <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {rootErr}
                </div>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-zinc-100 px-6 py-4">
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                onClick={() => setCreateModalOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={rootBusy}
                onClick={() => void submitCreateRoot()}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {rootBusy ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {moveModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/45 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
            <div className="shrink-0 border-b border-zinc-100 px-6 py-4">
              <h3 className="text-lg font-semibold text-zinc-900">批量移动</h3>
              <p className="mt-1 text-sm text-zinc-500">
                选择目标父节点（根表示移动到最外层）。
              </p>
            </div>
            <div className="space-y-4 px-6 py-4">
              <div>
                <label className="text-sm font-medium text-zinc-700">
                  目标位置
                </label>
                <select
                  className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                  value={moveTargetId}
                  onChange={(e) => setMoveTargetId(e.target.value)}
                >
                  <option value="__root__">（移动到根）</option>
                  {moveOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                  onClick={() => setMoveModalOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={batchWorking}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                  onClick={runBatchMove}
                >
                  移动
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

