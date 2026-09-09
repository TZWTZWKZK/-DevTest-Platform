"use client";

import type { TestCaseStatus } from "@prisma/client";
import {
  testCaseStatusOptions,
  testCaseStatusSelectOptionStyle,
} from "@/lib/test-labels";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  addExecutionTaskCaseExecRecord,
  addExecutionTaskLinkedTestCases,
  getExecutionImportedCaseColumnConfig,
  removeExecutionTaskLinkedTestCases,
  saveExecutionImportedCaseColumnConfig,
  type ActionResult,
} from "@/app/actions/executions";
import {
  bulkUpdateTestCasesMeta,
  getTestCasesExportRows,
  type TestCaseFolderFlat,
} from "@/app/actions/test-cases";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_SECONDARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import { TableColumnResizeHandle } from "@/components/TableColumnResizeHandle";
import { TestCaseLibraryClient } from "@/components/TestCaseLibraryClient";
import { formatCaseLevelDisplay } from "@/lib/case-level";
import {
  type ExecImportedCaseColumnKey,
  EXEC_IMPORTED_CASE_COLUMN_KEYS,
  useExecutionImportedCaseColumns,
} from "@/hooks/useExecutionImportedCaseColumns";
import {
  DEFAULT_TEST_CASE_EXPORT_FIELDS,
  TEST_CASE_EXPORT_COLUMN_KEYS,
} from "@/hooks/useTestCaseListColumns";
import {
  buildTestCaseExportCsv,
  downloadTestCaseExportCsv,
} from "@/lib/test-case-export-csv";
import { usePagination } from "@/hooks/usePagination";
import { useRowCheckboxBrushByIds } from "@/hooks/useRowCheckboxBrushByIds";

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Server → Client 传参后 Date 会变成 ISO 字符串，需统一还原 */
function coerceToDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function coerceToIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

const testCaseStatusLabel: Record<TestCaseStatus, string> = {
  PASSED: "通过",
  FAILED: "失败",
  BLOCKED: "阻塞",
  DEPRECATED: "废弃",
  REQ_TRANSFER: "转需求",
};

const testCaseStatusBadgeClass: Record<TestCaseStatus, string> = {
  PASSED: "border-emerald-300 bg-emerald-50 text-emerald-800",
  FAILED: "border-red-300 bg-red-50 text-red-800",
  BLOCKED: "border-amber-300 bg-amber-50 text-amber-900",
  DEPRECATED: "border-zinc-300 bg-zinc-100 text-zinc-600",
  REQ_TRANSFER: "border-violet-300 bg-violet-50 text-violet-800",
};

/** 列表头/高级筛选共用：statusIn 为空表示不过滤；`__UNSET__` 表示 status 为空 */
const IMPORTED_STATUS_FILTER_UNSET = "__UNSET__";

const IMPORTED_STATUS_HEADER_CHEVRON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E";

function importedStatusFilterSummary(
  statusIn: Array<TestCaseStatus | typeof IMPORTED_STATUS_FILTER_UNSET>,
): string {
  if (statusIn.length === 0) return "全部";
  if (statusIn.length === 1) {
    const only = statusIn[0]!;
  if (only === IMPORTED_STATUS_FILTER_UNSET) return "未标记";
  return testCaseStatusLabel[only] ?? only;
  }
  return `已选 ${statusIn.length} 项`;
}

const ALL_IMPORTED_STATUS_FILTER_OPTIONS = [
  { value: IMPORTED_STATUS_FILTER_UNSET, label: "未标记" },
  ...(Object.keys(testCaseStatusLabel) as TestCaseStatus[]).map((s) => ({
    value: s,
    label: testCaseStatusLabel[s],
  })),
] as const;

type ImportedStatusFilterValue =
  (typeof ALL_IMPORTED_STATUS_FILTER_OPTIONS)[number]["value"];

export type ExecutionTaskDetail = {
  id: string;
  title: string;
  description: string | null;
  iterationId: string;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
  iteration: {
    id: string;
    name: string;
    code: string;
    productId: string;
    product: { id: string; name: string };
  };
  linkedCases: Array<{
    createdAt: Date;
    testCase: {
      id: string;
      caseNo: string;
      title: string;
      status: TestCaseStatus | null;
      priority: number | null;
      maintainer: string | null;
      submitter: string | null;
      updatedAt: Date;
      createdAt: Date;
      folder: { id: string; name: string };
    };
  }>;
};

export function ExecutionTaskDetailClient({
  initial,
  siblingTasks,
  testCaseFolders,
}: {
  initial: ExecutionTaskDetail;
  siblingTasks: Array<{ id: string; title: string; parentId: string | null }>;
  testCaseFolders: TestCaseFolderFlat[];
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [editCaseId, setEditCaseId] = useState<string | null>(null);

  const [q, setQ] = useState("");

  const linkedRows = useMemo(
    () =>
      initial.linkedCases.map((x) => ({
        ...x.testCase,
        createdAt: coerceToDate(
          x.testCase.createdAt as Date | string,
        ),
        updatedAt: coerceToDate(
          x.testCase.updatedAt as Date | string,
        ),
        linkedAt: coerceToIso(x.createdAt as Date | string),
      })),
    [initial.linkedCases],
  );

  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const pickedIdsRef = useRef(pickedIds);
  pickedIdsRef.current = pickedIds;
  const pickedSet = useMemo(() => new Set(pickedIds), [pickedIds]);
  const pickAllRef = useRef<HTMLInputElement | null>(null);
  const pickAllFullVisibleRef = useRef<HTMLInputElement | null>(null);

  const DEFAULT_DETAIL_ADV = useMemo(
    () => ({
      caseNoContains: "",
      titleContains: "",
      /** 空数组表示不过滤；可多项组合（含未填） */
      statusIn: [] as ImportedStatusFilterValue[],
      priorityText: "",
      maintainer: "",
      submitter: "",
      updatedFrom: "",
      updatedTo: "",
    }),
    [],
  );
  const [detailAdvFilter, setDetailAdvFilter] = useState({ ...DEFAULT_DETAIL_ADV });
  const [detailAdvOpen, setDetailAdvOpen] = useState(false);
  const [statusHeaderFilterOpen, setStatusHeaderFilterOpen] = useState(false);
  const statusHeaderFilterRef = useRef<HTMLDivElement | null>(null);

  const hasActiveDetailFilters = useMemo(() => {
    if (q.trim()) return true;
    const f = detailAdvFilter;
    return (
      f.caseNoContains.trim() !== "" ||
      f.titleContains.trim() !== "" ||
      f.statusIn.length > 0 ||
      f.priorityText.trim() !== "" ||
      f.maintainer.trim() !== "" ||
      f.submitter.trim() !== "" ||
      f.updatedFrom !== "" ||
      f.updatedTo !== ""
    );
  }, [detailAdvFilter, q]);

  const clearAllDetailFilters = useCallback(() => {
    setQ("");
    setDetailAdvFilter({ ...DEFAULT_DETAIL_ADV });
    setStatusHeaderFilterOpen(false);
  }, [DEFAULT_DETAIL_ADV]);

  const toggleStatusInFilter = useCallback((value: ImportedStatusFilterValue) => {
    setDetailAdvFilter((p) => {
      const set = new Set(p.statusIn);
      if (set.has(value)) set.delete(value);
      else set.add(value);
      return { ...p, statusIn: Array.from(set) };
    });
  }, []);

  const advFilteredRows = useMemo(() => {
    return linkedRows.filter((c) => {
      const cn = detailAdvFilter.caseNoContains.trim().toLowerCase();
      if (cn && !c.caseNo.toLowerCase().includes(cn)) return false;
      const tn = detailAdvFilter.titleContains.trim().toLowerCase();
      if (tn && !c.title.toLowerCase().includes(tn)) return false;
      if (detailAdvFilter.statusIn.length > 0) {
        const wantsUnset = detailAdvFilter.statusIn.includes(
          IMPORTED_STATUS_FILTER_UNSET,
        );
        const statusValues = detailAdvFilter.statusIn.filter(
          (s): s is TestCaseStatus => s !== IMPORTED_STATUS_FILTER_UNSET,
        );
        const matchUnset = wantsUnset && c.status == null;
        const matchStatus =
          c.status != null && statusValues.includes(c.status);
        if (!matchUnset && !matchStatus) return false;
      }
      const p = detailAdvFilter.priorityText.trim();
      if (p) {
        const rawLow = p.toLowerCase();
        const m = rawLow.match(/^l?([0-4])$/);
        const tier = m ? Number(m[1]) : null;
        const n = Number.parseInt(p, 10);
        const disp = formatCaseLevelDisplay(c.priority).toLowerCase();
        const ok =
          (tier !== null && c.priority === tier) ||
          (!Number.isNaN(n) && c.priority === n) ||
          disp.includes(rawLow) ||
          String(c.priority ?? "").includes(p);
        if (!ok) return false;
      }
      const m = detailAdvFilter.maintainer.trim().toLowerCase();
      if (m && !(c.maintainer ?? "").toLowerCase().includes(m)) return false;
      const s0 = detailAdvFilter.submitter.trim().toLowerCase();
      if (s0 && !(c.submitter ?? "").toLowerCase().includes(s0)) return false;
      const from = detailAdvFilter.updatedFrom
        ? new Date(detailAdvFilter.updatedFrom).getTime()
        : null;
      const to = detailAdvFilter.updatedTo
        ? new Date(detailAdvFilter.updatedTo).getTime()
        : null;
      const ts = c.updatedAt.getTime();
      if (from !== null && ts < from) return false;
      if (to !== null && ts > to) return false;
      return true;
    });
  }, [linkedRows, detailAdvFilter]);

  const filteredLinkedRows = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return advFilteredRows;
    return advFilteredRows.filter(
      (c) =>
        c.caseNo.toLowerCase().includes(s) ||
        c.title.toLowerCase().includes(s) ||
        (c.maintainer ?? "").toLowerCase().includes(s) ||
        (c.submitter ?? "").toLowerCase().includes(s),
    );
  }, [advFilteredRows, q]);

  const allLinkedFilteredIds = useMemo(
    () => filteredLinkedRows.map((r) => r.id),
    [filteredLinkedRows],
  );

  const importedPager = usePagination(filteredLinkedRows, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.executionDetailLinked",
  });
  const pagedImportedRows = importedPager.pagedItems;
  const pagedImportedRowIdsRef = useRef<string[]>([]);
  pagedImportedRowIdsRef.current = pagedImportedRows.map((r) => r.id);
  const {
    onRowCheckboxPointerDown: onLinkedImportedCheckboxPointerDown,
    tableBodyRef: linkedImportedTableBodyRef,
  } = useRowCheckboxBrushByIds({
    pagedRowIdsRef: pagedImportedRowIdsRef,
    selectedIdsRef: pickedIdsRef,
    setSelectedIds: setPickedIds,
  });

  useEffect(() => {
    // 过滤变化时，尽量保持选择仅包含仍可见的行
    const visibleSet = new Set(filteredLinkedRows.map((r) => r.id));
    setPickedIds((prev) => prev.filter((id) => visibleSet.has(id)));
  }, [filteredLinkedRows]);

  useEffect(() => {
    const el = pickAllRef.current;
    if (!el) return;
    if (pickedIds.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    if (pagedImportedRows.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const pageIds = pagedImportedRows.map((r) => r.id);
    const picked = new Set(pickedIds);
    const allPageSelected =
      pageIds.length > 0 && pageIds.every((id) => picked.has(id));
    el.indeterminate = !allPageSelected;
    el.checked = allPageSelected;
  }, [pagedImportedRows, pickedIds]);

  useEffect(() => {
    const el = pickAllFullVisibleRef.current;
    if (!el) return;
    const ids = allLinkedFilteredIds;
    if (ids.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const fullSet = new Set(ids);
    const exactAll =
      pickedIds.length === ids.length &&
      pickedIds.every((id) => fullSet.has(id));
    const someInList = ids.some((id) => pickedIds.includes(id));
    el.checked = exactAll;
    el.indeterminate = someInList && !exactAll;
  }, [allLinkedFilteredIds, pickedIds]);

  const togglePickAll = useCallback(() => {
    const ids = pagedImportedRows.map((r) => r.id);
    if (ids.length === 0) return;
    setPickedIds((prev) => {
      const pageSet = new Set(ids);
      const allOn = ids.every((id) => prev.includes(id));
      return allOn
        ? prev.filter((id) => !pageSet.has(id))
        : [...new Set([...prev, ...ids])];
    });
  }, [pagedImportedRows]);

  const togglePickAllLinkedFullVisible = useCallback(() => {
    const ids = allLinkedFilteredIds;
    if (ids.length === 0) return;
    setPickedIds((prev) => {
      const fullSet = new Set(ids);
      const exact =
        prev.length === ids.length &&
        prev.every((id) => fullSet.has(id));
      if (exact) return [];
      return [...ids];
    });
  }, [allLinkedFilteredIds]);

  const removePicked = useCallback(async () => {
    const ids = pickedIds.filter((id) => filteredLinkedRows.some((r) => r.id === id));
    if (ids.length === 0) return;
    if (!window.confirm(`确定移除已选 ${ids.length} 条导入用例？将同时删除本任务下这些用例的执行记录。`)) return;
    const r = await removeExecutionTaskLinkedTestCases(initial.id, ids);
    setMsg(r);
    if (r.ok) {
      setPickedIds([]);
      router.refresh();
    }
  }, [filteredLinkedRows, initial.id, pickedIds, router]);

  const linkedIdSet = useMemo(
    () => new Set(linkedRows.map((r) => r.id)),
    [linkedRows],
  );

  const handleImportFromLibrary = useCallback(
    async (ids: string[]) => {
      const r = await addExecutionTaskLinkedTestCases(initial.id, ids);
      setMsg(r);
      if (r.ok) {
        setImportOpen(false);
        router.refresh();
      }
    },
    [initial.id, router],
  );

  const linkedCaseIds = useMemo(
    () => linkedRows.map((r) => r.id),
    [linkedRows],
  );

  const [importOpen, setImportOpen] = useState(false);
  const [exportWorking, setExportWorking] = useState(false);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [batchEditWorking, setBatchEditWorking] = useState(false);
  const [batchStatusSel, setBatchStatusSel] = useState("keep");
  const [batchPrioritySel, setBatchPrioritySel] = useState("keep");
  const [batchMaintainerApply, setBatchMaintainerApply] = useState(false);
  const [batchMaintainerText, setBatchMaintainerText] = useState("");
  const [batchSubmitterApply, setBatchSubmitterApply] = useState(false);
  const [batchSubmitterText, setBatchSubmitterText] = useState("");

  const submitBatchEdit = useCallback(async () => {
    const ids = pickedIds.filter((id) => filteredLinkedRows.some((r) => r.id === id));
    if (ids.length === 0) return;
    const updates: {
      status?: TestCaseStatus | null;
      priority?: number | null;
      maintainer?: string | null;
      submitter?: string | null;
    } = {};
    const setTaskStatus =
      batchStatusSel !== "keep" && batchStatusSel !== "clear"
        ? (batchStatusSel as TestCaseStatus)
        : null;
    const clearLibraryStatus = batchStatusSel === "clear";
    // 任务内批量改状态：写入执行记录并回写用例库；「清空」仅清空用例库状态（任务展示仍跟执行记录）
    if (clearLibraryStatus) updates.status = null;
    if (batchPrioritySel === "unset") updates.priority = null;
    else if (batchPrioritySel !== "keep") updates.priority = Number(batchPrioritySel);
    if (batchMaintainerApply) updates.maintainer = batchMaintainerText.trim() || null;
    if (batchSubmitterApply) updates.submitter = batchSubmitterText.trim() || null;
    if (!setTaskStatus && Object.keys(updates).length === 0) {
      setMsg({ error: "请至少选择一项要修改的内容" });
      return;
    }
    setBatchEditWorking(true);
    setMsg(null);
    try {
      if (Object.keys(updates).length > 0) {
        const r = await bulkUpdateTestCasesMeta({ ids, updates });
        if (r.error) {
          setMsg(r);
          return;
        }
      }
      if (setTaskStatus) {
        for (const caseId of ids) {
          const r = await addExecutionTaskCaseExecRecord({
            executionTaskId: initial.id,
            testCaseId: caseId,
            status: setTaskStatus,
            executor: batchSubmitterApply
              ? batchSubmitterText.trim() || null
              : null,
            result: null,
            note: "批量修改状态",
          });
          if (r.error) {
            setMsg(r);
            return;
          }
        }
      }
      setMsg({ ok: true });
      setBatchEditOpen(false);
      router.refresh();
    } finally {
      setBatchEditWorking(false);
    }
  }, [
    pickedIds,
    filteredLinkedRows,
    batchStatusSel,
    batchPrioritySel,
    batchMaintainerApply,
    batchMaintainerText,
    batchSubmitterApply,
    batchSubmitterText,
    initial.id,
    router,
  ]);

  const runExportCases = useCallback(async () => {
    const ids =
      pickedIds.length > 0
        ? pickedIds.filter((id) => filteredLinkedRows.some((r) => r.id === id))
        : allLinkedFilteredIds;
    if (ids.length === 0) {
      setMsg({ error: "没有可导出的用例" });
      return;
    }
    const fields = TEST_CASE_EXPORT_COLUMN_KEYS.filter(
      (k) => DEFAULT_TEST_CASE_EXPORT_FIELDS[k],
    );
    setExportWorking(true);
    setMsg(null);
    try {
      const r = await getTestCasesExportRows(ids, initial.iteration.productId);
      if (r.error || !r.rows?.length) {
        setMsg({ error: r.error ?? "没有可导出的数据" });
        return;
      }
      downloadTestCaseExportCsv(
        buildTestCaseExportCsv(r.rows, fields),
        "任务用例导出",
      );
    } catch {
      setMsg({ error: "导出失败，请稍后重试" });
    } finally {
      setExportWorking(false);
    }
  }, [
    pickedIds,
    filteredLinkedRows,
    allLinkedFilteredIds,
    initial.iteration.productId,
  ]);

  const [asidePaneW, setAsidePaneW] = useState(168);
  const [idxColW, setIdxColW] = useState(40);
  const importedColPanelRef = useRef<HTMLDivElement | null>(null);
  const [importedColPanelOpen, setImportedColPanelOpen] = useState(false);
  const importedColSaveSigRef = useRef<string>("");
  const {
    config: importedColConfig,
    mergeFromServer,
    visibleOrdered: importedVisibleOrdered,
    setVisible: setImportedVisible,
    moveKey: moveImportedKey,
    setWidth: setImportedWidth,
    widthFor: importedWidthFor,
    resetDefaults: resetImportedCols,
    labels: importedColLabels,
  } = useExecutionImportedCaseColumns();

  useEffect(() => {
    void (async () => {
      const r = await getExecutionImportedCaseColumnConfig();
      if (r.config) mergeFromServer(r.config);
    })();
  }, [mergeFromServer]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const keySet = new Set<string>(EXEC_IMPORTED_CASE_COLUMN_KEYS);
      const safeOrder = importedColConfig.order.filter(
        (k): k is ExecImportedCaseColumnKey =>
          typeof k === "string" && keySet.has(k),
      );
      const safeVisible = Object.fromEntries(
        Object.entries(importedColConfig.visible ?? {}).filter(
          ([k, v]) => keySet.has(k) && typeof v === "boolean",
        ),
      ) as Record<ExecImportedCaseColumnKey, boolean>;
      const safeWidths = Object.fromEntries(
        Object.entries(importedColConfig.widths ?? {}).filter(
          ([k, v]) => keySet.has(k) && typeof v === "number" && Number.isFinite(v),
        ),
      ) as Partial<Record<ExecImportedCaseColumnKey, number>>;
      const safeConfig = { order: safeOrder, visible: safeVisible, widths: safeWidths };
      const nextSig = JSON.stringify(safeConfig);
      if (importedColSaveSigRef.current === nextSig) return;
      importedColSaveSigRef.current = nextSig;
      void saveExecutionImportedCaseColumnConfig({ config: safeConfig });
    }, 450);
    return () => clearTimeout(t);
  }, [importedColConfig]);

  useEffect(() => {
    if (!importedColPanelOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = importedColPanelRef.current;
      if (!el) return;
      const t = e.target as unknown;
      if (!(t instanceof Element)) return;
      if (!el.contains(t)) setImportedColPanelOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [importedColPanelOpen]);

  useEffect(() => {
    if (!statusHeaderFilterOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = statusHeaderFilterRef.current;
      if (!el) return;
      const t = e.target as unknown;
      if (!(t instanceof Element)) return;
      if (!el.contains(t)) setStatusHeaderFilterOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [statusHeaderFilterOpen]);

  const startResizeAside = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const w0 = asidePaneW;
    const move = (ev: globalThis.MouseEvent) => {
      const dx = ev.clientX - sx;
      setAsidePaneW(Math.min(360, Math.max(120, w0 + dx)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [asidePaneW]);

  const startResizeImportedPair = useCallback(
    (
      left: ExecImportedCaseColumnKey | "__idx__",
      right: ExecImportedCaseColumnKey,
    ) =>
      (e: ReactMouseEvent) => {
        e.preventDefault();
        const sx = e.clientX;
        const leftW0 = left === "__idx__" ? idxColW : importedWidthFor(left);
        const rightW0 = importedWidthFor(right);
        const move = (ev: globalThis.MouseEvent) => {
          const dx = ev.clientX - sx;
          if (left === "__idx__") {
            setIdxColW(Math.min(56, Math.max(28, leftW0 + dx)));
            setImportedWidth(right, rightW0 - dx);
          } else {
            setImportedWidth(left, leftW0 + dx);
            setImportedWidth(right, rightW0 - dx);
          }
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      },
    [idxColW, importedWidthFor, setImportedWidth],
  );

  const removeOne = useCallback(
    async (testCaseId: string) => {
      if (!window.confirm("确定移除该导入用例？将同时删除本任务下该用例的执行记录。")) return;
      const r = await removeExecutionTaskLinkedTestCases(initial.id, [testCaseId]);
      setMsg(r);
      if (r.ok) router.refresh();
    },
    [initial.id, router],
  );

  const renderImportedCell = (
    c: (typeof linkedRows)[number],
    key: ExecImportedCaseColumnKey,
  ) => {
    switch (key) {
      case "caseNo":
        return (
          <td
            key={key}
            className="px-2 py-2 align-top font-mono text-xs italic text-zinc-500 tabular-nums"
          >
            {c.caseNo}
          </td>
        );
      case "title":
        return (
          <td key={key} className="max-w-0 px-2 py-2 align-top text-zinc-800">
            <div className="truncate" title={c.title}>
              {c.title}
            </div>
          </td>
        );
      case "status":
        return (
          <td key={key} className="px-2 py-2 align-top">
            <span
              className={[
                "inline-flex max-w-full rounded-full border px-2 py-0.5 text-xs font-medium",
                c.status ? testCaseStatusBadgeClass[c.status] : "border-zinc-200 bg-zinc-50 text-zinc-600",
              ].join(" ")}
            >
              {c.status ? testCaseStatusLabel[c.status] : "未标记"}
            </span>
          </td>
        );
      case "priority": {
        const t = formatCaseLevelDisplay(c.priority);
        return (
          <td key={key} className="px-2 py-2 align-top text-xs text-zinc-600">
            {t || ""}
          </td>
        );
      }
      case "maintainer":
        return (
          <td key={key} className="px-2 py-2 align-top text-xs text-zinc-600">
            {c.maintainer ?? "—"}
          </td>
        );
      case "submitter":
        return (
          <td key={key} className="px-2 py-2 align-top text-xs text-zinc-600">
            {c.submitter ?? "—"}
          </td>
        );
      case "updatedAt":
        return (
          <td key={key} className="px-2 py-2 align-top text-xs text-zinc-600 tabular-nums">
            {formatTs(coerceToIso(c.updatedAt))}
          </td>
        );
      case "createdAt":
        return (
          <td key={key} className="px-2 py-2 align-top text-xs text-zinc-600 tabular-nums">
            {formatTs(coerceToIso(c.createdAt))}
          </td>
        );
      case "ops":
        return (
          <td key={key} className="px-2 py-2 text-center align-top">
            <button
              type="button"
              className="rounded-md border border-red-200/80 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
              title="从任务中移除该用例"
              onClick={(e) => {
                e.stopPropagation();
                void removeOne(c.id);
              }}
            >
              移除
            </button>
          </td>
        );
      default:
        return (
          <td key={key} className="px-2 py-2 text-xs text-zinc-500">
            —
          </td>
        );
    }
  };

  const firstImportedCol = importedVisibleOrdered[0];
  const importedTableMinW = useMemo(() => {
    const cols = importedVisibleOrdered.reduce(
      (sum, k) => sum + importedWidthFor(k),
      52 + idxColW,
    );
    return Math.max(720, cols);
  }, [importedVisibleOrdered, importedWidthFor, idxColW]);

  return (
    <ModuleWorkspaceCard>
      <div className="flex min-h-[70vh] flex-col lg:flex-row">
        <aside
          className="flex w-full shrink-0 flex-col border-b border-zinc-200 bg-zinc-50/60 p-3 lg:min-w-0 lg:max-w-[min(100vw,360px)] lg:border-b-0 lg:border-r"
          style={{ width: asidePaneW, maxWidth: "100%" }}
        >
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            执行任务
          </div>
          <div className="mt-2 text-[11px] leading-snug text-zinc-500">
            {initial.iteration.product.name}
            <br />
            {initial.iteration.name}
          </div>
          <div className="mt-2">
            <Link
              href={`/executions?iterationId=${encodeURIComponent(initial.iteration.id)}`}
              className="inline-flex text-xs font-medium text-blue-700 hover:underline"
            >
              ← 返回执行任务的当前迭代界面
            </Link>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-auto lg:max-h-[min(85vh,900px)]">
            {siblingTasks.length === 0 ? (
              <div className="text-xs text-zinc-500">暂无任务。</div>
            ) : (
              <div className="space-y-1">
                {siblingTasks.map((t) => {
                  const active = t.id === initial.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={[
                        "w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                        active
                          ? "bg-zinc-900 text-white"
                          : "text-zinc-700 hover:bg-zinc-100",
                      ].join(" ")}
                      title={t.title}
                      onClick={() => router.push(`/executions/task/${t.id}`)}
                    >
                      <div className="truncate">{t.title}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <button
          type="button"
          aria-label="左右拖动调整任务列表宽度"
          title="拖动调整宽度"
          className="hidden shrink-0 cursor-col-resize border-0 bg-transparent px-0 hover:bg-sky-500/15 lg:block lg:w-1.5"
          onMouseDown={startResizeAside}
        />

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
          <div className="flex min-h-0 flex-1 flex-col p-4">
            {msg?.error ? (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {msg.error}
              </div>
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
                <span>已导入用例 {filteredLinkedRows.length} 条</span>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    aria-expanded={detailAdvOpen}
                    onClick={() => setDetailAdvOpen((o) => !o)}
                  >
                    <span>高级筛选</span>{" "}
                    <span className="ml-1 text-zinc-400">
                      {detailAdvOpen ? "▼" : "▶"}
                    </span>
                  </button>
                  {hasActiveDetailFilters ? (
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                      onClick={clearAllDetailFilters}
                    >
                      清除筛选
                    </button>
                  ) : null}
                  <div className="relative" ref={importedColPanelRef}>
                    <button
                      type="button"
                      className={MODULE_TOOLBAR_BTN_SECONDARY}
                      title="已导入用例表：列显隐、顺序；表头竖线调宽"
                      aria-expanded={importedColPanelOpen}
                      aria-haspopup="true"
                      aria-label="已导入用例列设置"
                      onClick={() => setImportedColPanelOpen((o) => !o)}
                    >
                      ⚙
                    </button>
                    {importedColPanelOpen ? (
                      <div
                        className="absolute right-0 top-full z-[150] mt-1.5 w-80 max-h-[min(70vh,28rem)] overflow-y-auto rounded-lg border border-zinc-200 bg-white p-3 text-left shadow-xl"
                        role="dialog"
                        aria-label="列设置"
                      >
                        <p className="text-xs leading-relaxed text-zinc-500">
                          勾选表示在表格中显示。使用上下箭头调整列的先后顺序。在表头列右侧的竖线上按住拖动可调整列宽。配置会保存到服务端。
                        </p>
                        <ul className="mt-3 space-y-1">
                          {importedColConfig.order.map((key, idx) => (
                            <li
                              key={key}
                              className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-zinc-50"
                            >
                              <input
                                id={`imp-col-${key}`}
                                type="checkbox"
                                className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                checked={importedColConfig.visible[key] !== false}
                                onChange={(e) => setImportedVisible(key, e.target.checked)}
                              />
                              <label
                                htmlFor={`imp-col-${key}`}
                                className="min-w-0 flex-1 cursor-pointer text-sm text-zinc-800"
                              >
                                {importedColLabels[key]}
                              </label>
                              <div className="flex shrink-0 gap-0.5">
                                <button
                                  type="button"
                                  className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 disabled:opacity-30"
                                  disabled={idx === 0}
                                  title="上移"
                                  onClick={() => moveImportedKey(key, -1)}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="rounded border border-zinc-200 px-1.5 py-0.5 text-xs text-zinc-600 disabled:opacity-30"
                                  disabled={idx === importedColConfig.order.length - 1}
                                  title="下移"
                                  onClick={() => moveImportedKey(key, 1)}
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
                          onClick={() => resetImportedCols()}
                        >
                          恢复默认列
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    disabled={exportWorking || filteredLinkedRows.length === 0}
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    title={
                      pickedIds.length > 0
                        ? `导出已选 ${pickedIds.length} 条用例为 CSV`
                        : "未勾选时导出当前列表全部用例（含筛选结果）"
                    }
                    onClick={() => void runExportCases()}
                  >
                    {exportWorking
                      ? "导出中…"
                      : pickedIds.length > 0
                        ? `导出用例（${pickedIds.length}）`
                        : "导出用例"}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white"
                    onClick={() => setImportOpen(true)}
                  >
                    + 导入用例
                  </button>
                  <button
                    type="button"
                    disabled={pickedIds.length === 0}
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    title="批量修改选中用例在用例库中的状态、等级与维护信息"
                    onClick={() => {
                      setBatchStatusSel("keep");
                      setBatchPrioritySel("keep");
                      setBatchMaintainerApply(false);
                      setBatchMaintainerText("");
                      setBatchSubmitterApply(false);
                      setBatchSubmitterText("");
                      setBatchEditOpen(true);
                    }}
                  >
                    {pickedIds.length > 0
                      ? `批量修改（${pickedIds.length}）`
                      : "批量修改"}
                  </button>
                  <button
                    type="button"
                    disabled={pickedIds.length === 0}
                    className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    onClick={() => void removePicked()}
                    title="批量从本任务移除（会删除本任务下对应执行记录）"
                  >
                    {pickedIds.length > 0 ? `批量移除（${pickedIds.length}）` : "批量移除"}
                  </button>
                  <input
                    type="search"
                    className="w-[min(420px,60vw)] min-w-[200px] rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-800"
                    placeholder="模糊查询：编号 / 名称 / 维护人 / 提交人"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
              </div>
              {detailAdvOpen ? (
                <div className="shrink-0 border-b border-zinc-100 bg-zinc-50/50 px-3 py-3">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        用例编号包含
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        value={detailAdvFilter.caseNoContains}
                        onChange={(e) =>
                          setDetailAdvFilter((p) => ({
                            ...p,
                            caseNoContains: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        名称包含
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        value={detailAdvFilter.titleContains}
                        onChange={(e) =>
                          setDetailAdvFilter((p) => ({
                            ...p,
                            titleContains: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="text-xs font-medium text-zinc-600">
                        状态（可多选）
                      </label>
                      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-2">
                        {ALL_IMPORTED_STATUS_FILTER_OPTIONS.map((o) => (
                          <label
                            key={o.value}
                            className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-zinc-800"
                          >
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-zinc-300"
                              checked={detailAdvFilter.statusIn.includes(o.value)}
                              onChange={() => toggleStatusInFilter(o.value)}
                            />
                            {o.label}
                          </label>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        用例等级
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        placeholder="如 L2、2"
                        value={detailAdvFilter.priorityText}
                        onChange={(e) =>
                          setDetailAdvFilter((p) => ({
                            ...p,
                            priorityText: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        维护人
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        value={detailAdvFilter.maintainer}
                        onChange={(e) =>
                          setDetailAdvFilter((p) => ({
                            ...p,
                            maintainer: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        提交人
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        value={detailAdvFilter.submitter}
                        onChange={(e) =>
                          setDetailAdvFilter((p) => ({
                            ...p,
                            submitter: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        更新时间起
                      </label>
                      <input
                        type="datetime-local"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        value={detailAdvFilter.updatedFrom}
                        onChange={(e) =>
                          setDetailAdvFilter((p) => ({
                            ...p,
                            updatedFrom: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        更新时间止
                      </label>
                      <input
                        type="datetime-local"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        value={detailAdvFilter.updatedTo}
                        onChange={(e) =>
                          setDetailAdvFilter((p) => ({
                            ...p,
                            updatedTo: e.target.value,
                          }))
                        }
                      />
                    </div>
                    <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                        onClick={() =>
                          setDetailAdvFilter({ ...DEFAULT_DETAIL_ADV })
                        }
                      >
                        重置筛选
                      </button>
                      {detailAdvFilter.statusIn.length > 0 ? (
                        <button
                          type="button"
                          className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                          onClick={() =>
                            setDetailAdvFilter((p) => ({ ...p, statusIn: [] }))
                          }
                        >
                          清除状态筛选
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-auto overscroll-contain max-h-[min(85vh,960px)]">
                {linkedRows.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-zinc-500">
                    暂无已导入用例。
                  </div>
                ) : (
                  <table
                    className="table-fixed text-left text-sm"
                    style={{
                      width: importedTableMinW,
                      minWidth: importedTableMinW,
                    }}
                  >
                    <colgroup>
                      <col style={{ width: 52 }} />
                      <col style={{ width: idxColW }} />
                      {importedVisibleOrdered.map((k) => (
                        <col key={k} style={{ width: importedWidthFor(k) }} />
                      ))}
                    </colgroup>
                    <thead className="sticky top-0 z-[1] border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                      <tr>
                        <th className="min-w-[3.25rem] px-2 py-2 text-left">
                          <div className="flex items-end gap-1">
                            <input
                              ref={pickAllRef}
                              type="checkbox"
                              className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300"
                              aria-label="全选当前页"
                              title="全选当前页（可与其它页已选合并）"
                              onChange={() => togglePickAll()}
                            />
                            <input
                              ref={pickAllFullVisibleRef}
                              type="checkbox"
                              className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300"
                              aria-label="全选全部可见已导入用例"
                              title="全选列表：选中当前筛选下全部已导入用例（与分页「/ 总数」一致）"
                              onChange={() => togglePickAllLinkedFullVisible()}
                            />
                          </div>
                        </th>
                        <th className="relative px-2 py-2 text-left">
                          #
                          {firstImportedCol ? (
                            <TableColumnResizeHandle
                              onResizeStart={startResizeImportedPair(
                                "__idx__",
                                firstImportedCol,
                              )}
                            />
                          ) : null}
                        </th>
                        {importedVisibleOrdered.map((k, i) => {
                          const isLast = i === importedVisibleOrdered.length - 1;
                          const next = importedVisibleOrdered[i + 1];
                          return (
                            <th
                              key={k}
                              className={[
                                "px-2 py-2 text-left font-medium",
                                !isLast ? "relative" : "",
                              ].join(" ")}
                            >
                              {k === "status" ? (
                                <div
                                  ref={statusHeaderFilterRef}
                                  className="relative inline-flex min-w-0 max-w-full items-center"
                                >
                                  <button
                                    type="button"
                                    className="group/st inline-flex min-w-0 max-w-full items-center gap-0.5 pr-1 text-left"
                                    title={`筛选状态（当前：${importedStatusFilterSummary(detailAdvFilter.statusIn)}）`}
                                    aria-expanded={statusHeaderFilterOpen}
                                    onClick={() =>
                                      setStatusHeaderFilterOpen((o) => !o)
                                    }
                                  >
                                    <span className="min-w-0 shrink truncate leading-tight">
                                      {importedColLabels[k]}
                                      {detailAdvFilter.statusIn.length > 0 ? (
                                        <span className="ml-1 tabular-nums text-zinc-400">
                                          ({detailAdvFilter.statusIn.length})
                                        </span>
                                      ) : null}
                                    </span>
                                    <span
                                      aria-hidden
                                      className="block h-4 w-4 shrink-0 bg-[length:14px_14px] bg-[position:center] bg-no-repeat opacity-70 transition-opacity group-hover/st:opacity-100"
                                      style={{
                                        backgroundImage: `url("${IMPORTED_STATUS_HEADER_CHEVRON}")`,
                                      }}
                                    />
                                  </button>
                                  {statusHeaderFilterOpen ? (
                                    <div
                                      className="absolute left-0 top-full z-30 mt-1 w-44 rounded-lg border border-zinc-200 bg-white p-2 text-left shadow-xl"
                                      role="dialog"
                                      aria-label="状态筛选"
                                    >
                                      <div className="max-h-52 space-y-1 overflow-y-auto">
                                        {ALL_IMPORTED_STATUS_FILTER_OPTIONS.map(
                                          (o) => (
                                            <label
                                              key={o.value}
                                              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-800 hover:bg-zinc-50"
                                            >
                                              <input
                                                type="checkbox"
                                                className="h-3.5 w-3.5 rounded border-zinc-300"
                                                checked={detailAdvFilter.statusIn.includes(
                                                  o.value,
                                                )}
                                                onChange={() =>
                                                  toggleStatusInFilter(o.value)
                                                }
                                              />
                                              {o.label}
                                            </label>
                                          ),
                                        )}
                                      </div>
                                      <div className="mt-2 flex flex-wrap gap-2 border-t border-zinc-100 pt-2">
                                        <button
                                          type="button"
                                          className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                          onClick={() =>
                                            setDetailAdvFilter((p) => ({
                                              ...p,
                                              statusIn: ALL_IMPORTED_STATUS_FILTER_OPTIONS.map(
                                                (o) => o.value,
                                              ),
                                            }))
                                          }
                                        >
                                          全选
                                        </button>
                                        <button
                                          type="button"
                                          className="rounded-md border border-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                                          onClick={() =>
                                            setDetailAdvFilter((p) => ({
                                              ...p,
                                              statusIn: [],
                                            }))
                                          }
                                        >
                                          清除筛选
                                        </button>
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                importedColLabels[k]
                              )}
                              {!isLast && next ? (
                                <TableColumnResizeHandle
                                  onResizeStart={startResizeImportedPair(k, next)}
                                />
                              ) : null}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody
                      ref={linkedImportedTableBodyRef}
                      className="divide-y divide-zinc-100"
                    >
                      {filteredLinkedRows.length === 0 ? (
                        <tr>
                          <td
                            colSpan={2 + importedVisibleOrdered.length}
                            className="px-3 py-10 text-center text-sm text-zinc-500"
                          >
                            当前筛选条件下暂无数据，请调整筛选或搜索。
                          </td>
                        </tr>
                      ) : (
                        pagedImportedRows.map((c, idx) => (
                          <tr
                            key={c.id}
                            data-pm-row-select={c.id}
                            className="cursor-pointer hover:bg-zinc-50/70"
                            onClick={() => setEditCaseId(c.id)}
                          >
                            <td
                              className="px-2 py-2 align-top"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 rounded border-zinc-300"
                                checked={pickedSet.has(c.id)}
                                aria-label={`选择用例 ${c.caseNo}`}
                                onChange={() => {}}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onPointerDown={(e) =>
                                  onLinkedImportedCheckboxPointerDown(e, c.id)
                                }
                                onKeyDown={(e) => {
                                  if (e.key !== " " && e.key !== "Enter") return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setPickedIds((prev) => {
                                    const s = new Set(prev);
                                    if (s.has(c.id)) s.delete(c.id);
                                    else s.add(c.id);
                                    return Array.from(s);
                                  });
                                }}
                                title="按住并拖动经过多行可连续勾选"
                              />
                            </td>
                            <td className="px-2 py-2 align-top text-xs text-zinc-400 tabular-nums">
                              {(importedPager.page - 1) *
                                importedPager.pageSize +
                                idx +
                                1}
                            </td>
                            {importedVisibleOrdered.map((k) =>
                              renderImportedCell(c, k),
                            )}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="shrink-0 border-t border-zinc-100 bg-zinc-50/50 px-3 py-2.5">
                <PaginationBar
                  page={importedPager.page}
                  pageCount={importedPager.pageCount}
                  pageSize={importedPager.pageSize}
                  pageSizeOptions={importedPager.pageSizeOptions}
                  rangeLabel={importedPager.rangeLabel}
                  onPageChange={importedPager.setPage}
                  onPageSizeChange={importedPager.setPageSize}
                  className="!mt-0"
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      {importOpen ? (
        <div className="fixed inset-0 z-50 flex flex-col bg-white">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-5 py-3">
            <div>
              <div className="text-sm font-semibold text-zinc-900">导入用例</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                在测试用例库中选择目录并勾选用例导入本任务；已导入的用例不可再次勾选。
              </div>
            </div>
            <button
              type="button"
              className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              onClick={() => setImportOpen(false)}
            >
              关闭
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
              <Suspense
                fallback={
                  <div className="flex h-full min-h-[400px] items-center justify-center text-sm text-zinc-500">
                    加载用例库…
                  </div>
                }
              >
                <TestCaseLibraryClient
                  importPickerMode
                  embedProductId={initial.iteration.productId}
                  initialFolders={testCaseFolders}
                  linkedCaseIds={linkedCaseIds}
                  onImportCases={handleImportFromLibrary}
                  onImportPickerClose={() => setImportOpen(false)}
                />
              </Suspense>
          </div>
        </div>
      ) : null}

      {batchEditOpen ? (
        <div className="fixed inset-0 z-[55] flex items-center justify-center overflow-y-auto bg-black/45 p-4">
          <div
            className="mb-8 w-full max-w-lg rounded-2xl border border-zinc-200 bg-white shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="batch-edit-title"
          >
            <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4">
              <div>
                <div id="batch-edit-title" className="text-sm font-semibold text-zinc-900">
                  批量修改用例
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  状态写入本任务执行记录并同步用例库；等级/维护人等写入用例库。状态选「清空」仅清空用例库状态。
                </div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                onClick={() => setBatchEditOpen(false)}
              >
                关闭
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div>
                <label className="text-xs font-medium text-zinc-600">状态</label>
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                  value={batchStatusSel}
                  onChange={(e) => setBatchStatusSel(e.target.value)}
                >
                  <option value="keep">（不修改）</option>
                  <option value="clear">（清空）</option>
                  {testCaseStatusOptions.map((o) => (
                    <option
                      key={o.value}
                      value={o.value}
                      style={testCaseStatusSelectOptionStyle[o.value]}
                    >
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-zinc-600">用例等级</label>
                <select
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                  value={batchPrioritySel}
                  onChange={(e) => setBatchPrioritySel(e.target.value)}
                >
                  <option value="keep">（不修改）</option>
                  <option value="unset">未设置</option>
                  {[0, 1, 2, 3, 4].map((n) => (
                    <option key={n} value={String(n)}>
                      L{n}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-700">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-zinc-300"
                    checked={batchMaintainerApply}
                    onChange={(e) => setBatchMaintainerApply(e.target.checked)}
                  />
                  更新维护人
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:bg-zinc-100"
                  disabled={!batchMaintainerApply}
                  value={batchMaintainerText}
                  onChange={(e) => setBatchMaintainerText(e.target.value)}
                  placeholder={batchMaintainerApply ? "留空则清空维护人" : "先勾选「更新维护人」"}
                />
              </div>
              <div className="rounded-lg border border-zinc-100 bg-zinc-50/60 px-3 py-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-zinc-700">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-zinc-300"
                    checked={batchSubmitterApply}
                    onChange={(e) => setBatchSubmitterApply(e.target.checked)}
                  />
                  更新提交人
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm disabled:bg-zinc-100"
                  disabled={!batchSubmitterApply}
                  value={batchSubmitterText}
                  onChange={(e) => setBatchSubmitterText(e.target.value)}
                  placeholder={batchSubmitterApply ? "留空则清空提交人" : "先勾选「更新提交人」"}
                />
              </div>
              <div className="flex flex-wrap justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  disabled={batchEditWorking}
                  onClick={() => setBatchEditOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                  disabled={batchEditWorking || pickedIds.length === 0}
                  onClick={() => void submitBatchEdit()}
                >
                  {batchEditWorking ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Suspense fallback={null}>
        <TestCaseLibraryClient
          embedMode
          embedProductId={initial.iteration.productId}
          initialFolders={testCaseFolders}
          openCaseId={editCaseId}
          executionTaskId={initial.id}
          onEmbedClose={() => setEditCaseId(null)}
          onEmbedSaved={() => router.refresh()}
        />
      </Suspense>
    </ModuleWorkspaceCard>
  );
}

