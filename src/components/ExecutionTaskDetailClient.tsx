"use client";

import type { TestCaseStatus } from "@prisma/client";
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
  addExecutionTaskLinkedTestCases,
  getExecutionImportedCaseColumnConfig,
  removeExecutionTaskLinkedTestCases,
  saveExecutionImportedCaseColumnConfig,
  type ActionResult,
} from "@/app/actions/executions";
import { listIterationCodeOptions } from "@/app/actions/iterations";
import {
  searchTestCaseIdOptions,
  type TestCaseFolderFlat,
  type TestCaseIdOption,
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
import { usePagination } from "@/hooks/usePagination";

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

const testCaseStatusLabel: Record<TestCaseStatus, string> = {
  PASSED: "通过",
  FAILED: "失败",
  BLOCKED: "阻塞",
  DEPRECATED: "废弃",
};

const testCaseStatusBadgeClass: Record<TestCaseStatus, string> = {
  PASSED: "border-emerald-300 bg-emerald-50 text-emerald-800",
  FAILED: "border-red-300 bg-red-50 text-red-800",
  BLOCKED: "border-amber-300 bg-amber-50 text-amber-900",
  DEPRECATED: "border-zinc-300 bg-zinc-100 text-zinc-600",
};

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
        linkedAt: x.createdAt.toISOString(),
      })),
    [initial.linkedCases],
  );

  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const pickedSet = useMemo(() => new Set(pickedIds), [pickedIds]);
  const pickAllRef = useRef<HTMLInputElement | null>(null);

  const DEFAULT_DETAIL_ADV = useMemo(
    () => ({
      caseNoContains: "",
      titleContains: "",
      status: "" as TestCaseStatus | "",
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

  const advFilteredRows = useMemo(() => {
    return linkedRows.filter((c) => {
      const cn = detailAdvFilter.caseNoContains.trim().toLowerCase();
      if (cn && !c.caseNo.toLowerCase().includes(cn)) return false;
      const tn = detailAdvFilter.titleContains.trim().toLowerCase();
      if (tn && !c.title.toLowerCase().includes(tn)) return false;
      if (detailAdvFilter.status && c.status !== detailAdvFilter.status) return false;
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

  const importedPager = usePagination(filteredLinkedRows, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.executionDetailLinked",
  });
  const pagedImportedRows = importedPager.pagedItems;

  useEffect(() => {
    // 过滤变化时，尽量保持选择仅包含仍可见的行
    const visibleSet = new Set(filteredLinkedRows.map((r) => r.id));
    setPickedIds((prev) => prev.filter((id) => visibleSet.has(id)));
  }, [filteredLinkedRows]);

  useEffect(() => {
    const el = pickAllRef.current;
    if (!el) return;
    if (pagedImportedRows.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const all = pagedImportedRows.every((r) => pickedSet.has(r.id));
    const some = pagedImportedRows.some((r) => pickedSet.has(r.id));
    el.indeterminate = some && !all;
    el.checked = all;
  }, [pagedImportedRows, pickedSet]);

  const togglePickAll = useCallback(() => {
    const ids = pagedImportedRows.map((r) => r.id);
    const all = ids.length > 0 && ids.every((id) => pickedSet.has(id));
    setPickedIds(all ? [] : ids);
  }, [pagedImportedRows, pickedSet]);

  const togglePickOne = useCallback((id: string) => {
    setPickedIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return Array.from(s);
    });
  }, []);

  const removePicked = useCallback(async () => {
    const ids = pickedIds.filter((id) => filteredLinkedRows.some((r) => r.id === id));
    if (ids.length === 0) return;
    if (!window.confirm(`确定移除已选 ${ids.length} 条导入用例？（不会影响历史执行记录）`)) return;
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

  const [importOpen, setImportOpen] = useState(false);
  const [iterOptions, setIterOptions] = useState<
    Array<{ code: string; label: string }>
  >([{ code: "", label: "baseline（全部迭代）" }]);
  const [importIterCode, setImportIterCode] = useState("");
  const [importQuery, setImportQuery] = useState("");
  const [importResults, setImportResults] = useState<TestCaseIdOption[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [importPickIds, setImportPickIds] = useState<string[]>([]);
  const importPickSet = useMemo(() => new Set(importPickIds), [importPickIds]);
  const importSelectAllRef = useRef<HTMLInputElement | null>(null);
  const [importTblChkW, setImportTblChkW] = useState(40);
  const [importTblNoW, setImportTblNoW] = useState(128);
  const [importTblNameW, setImportTblNameW] = useState(320);

  const importPendingRows = useMemo(
    () => importResults.filter((r) => !linkedIdSet.has(r.id)),
    [importResults, linkedIdSet],
  );

  useEffect(() => {
    void (async () => {
      try {
        const opts = await listIterationCodeOptions();
        setIterOptions(opts);
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (!importOpen) return;
    const t = window.setTimeout(() => {
      void (async () => {
        setImportLoading(true);
        try {
          const rows = await searchTestCaseIdOptions({
            q: importQuery,
            iterationCode: importIterCode || null,
            take: 200,
          });
          setImportResults(rows);
        } finally {
          setImportLoading(false);
        }
      })();
    }, 220);
    return () => clearTimeout(t);
  }, [importIterCode, importOpen, importQuery]);

  useEffect(() => {
    setImportPickIds([]);
  }, [importResults]);

  useEffect(() => {
    const el = importSelectAllRef.current;
    if (!el) return;
    if (importPendingRows.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const all = importPendingRows.every((r) => importPickSet.has(r.id));
    const some = importPendingRows.some((r) => importPickSet.has(r.id));
    el.indeterminate = some && !all;
    el.checked = all;
  }, [importPendingRows, importPickSet]);

  const startResizeImportChkVsNo = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = importTblChkW;
      const b0 = importTblNoW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setImportTblChkW(Math.min(56, Math.max(32, a0 + dx)));
        setImportTblNoW(Math.min(420, Math.max(88, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [importTblChkW, importTblNoW],
  );

  const startResizeImportNoVsName = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = importTblNoW;
      const b0 = importTblNameW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setImportTblNoW(Math.min(420, Math.max(88, a0 + dx)));
        setImportTblNameW(Math.min(820, Math.max(200, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [importTblNameW, importTblNoW],
  );

  const toggleImportPick = useCallback((id: string) => {
    setImportPickIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return Array.from(s);
    });
  }, []);

  const toggleImportPickAll = useCallback(() => {
    const ids = importPendingRows.map((r) => r.id);
    const all = ids.length > 0 && ids.every((id) => importPickSet.has(id));
    setImportPickIds(all ? [] : ids);
  }, [importPendingRows, importPickSet]);

  const doImport = useCallback(async () => {
    const ids = importPickIds.filter((id) =>
      importPendingRows.some((r) => r.id === id),
    );
    if (ids.length === 0) return;
    const r = await addExecutionTaskLinkedTestCases(initial.id, ids);
    setMsg(r);
    if (r.ok) {
      setImportOpen(false);
      router.refresh();
    }
  }, [importPickIds, importPendingRows, initial.id, router]);

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
            setImportedWidth(left, Math.min(560, Math.max(56, leftW0 + dx)));
            setImportedWidth(right, Math.min(560, Math.max(40, rightW0 - dx)));
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
      if (!window.confirm("确定移除该导入用例？")) return;
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
              {c.status ? testCaseStatusLabel[c.status] : "—"}
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
            {formatTs(c.updatedAt.toISOString())}
          </td>
        );
      case "createdAt":
        return (
          <td key={key} className="px-2 py-2 align-top text-xs text-zinc-600 tabular-nums">
            {formatTs(c.createdAt.toISOString())}
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
          <div className="min-h-0 flex-1 p-4">
            {msg?.error ? (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {msg.error}
              </div>
            ) : null}
            <div className="rounded-lg border border-zinc-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
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
                    className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white"
                    onClick={() => setImportOpen(true)}
                  >
                    + 导入用例
                  </button>
                  <button
                    type="button"
                    disabled={pickedIds.length === 0}
                    className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    onClick={() => void removePicked()}
                    title="批量从本任务移除（不影响历史执行记录）"
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
                <div className="border-b border-zinc-100 bg-zinc-50/50 px-3 py-3">
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
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        状态
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        value={detailAdvFilter.status}
                        onChange={(e) =>
                          setDetailAdvFilter((p) => ({
                            ...p,
                            status: e.target.value as TestCaseStatus | "",
                          }))
                        }
                      >
                        <option value="">全部</option>
                        {(Object.keys(testCaseStatusLabel) as TestCaseStatus[]).map(
                          (s) => (
                            <option key={s} value={s}>
                              {testCaseStatusLabel[s]}
                            </option>
                          ),
                        )}
                      </select>
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
                    <div className="flex items-end sm:col-span-2 lg:col-span-4">
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                        onClick={() =>
                          setDetailAdvFilter({ ...DEFAULT_DETAIL_ADV })
                        }
                      >
                        重置筛选
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="max-h-[min(85vh,960px)] overflow-auto">
                {filteredLinkedRows.length === 0 ? (
                  <div className="px-3 py-3 text-sm text-zinc-500">
                    暂无已导入用例。
                  </div>
                ) : (
                  <table className="w-max min-w-[720px] table-fixed text-sm">
                    <colgroup>
                      <col style={{ width: 36 }} />
                      <col style={{ width: idxColW }} />
                      {importedVisibleOrdered.map((k) => (
                        <col key={k} style={{ width: importedWidthFor(k) }} />
                      ))}
                    </colgroup>
                    <thead className="sticky top-0 z-[1] border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                      <tr>
                        <th className="px-2 py-2 text-left">
                          <input
                            ref={pickAllRef}
                            type="checkbox"
                            className="h-3.5 w-3.5 rounded border-zinc-300"
                            aria-label="全选当前列表"
                            onChange={() => togglePickAll()}
                          />
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
                              {importedColLabels[k]}
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
                    <tbody className="divide-y divide-zinc-100">
                      {pagedImportedRows.map((c, idx) => (
                        <tr
                          key={c.id}
                          className="cursor-pointer hover:bg-zinc-50/70"
                          onClick={() => setEditCaseId(c.id)}
                        >
                          <td className="px-2 py-2 align-top">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-zinc-300"
                              checked={pickedSet.has(c.id)}
                              aria-label={`选择用例 ${c.caseNo}`}
                              onChange={() => togglePickOne(c.id)}
                              onClick={(e) => e.stopPropagation()}
                            />
                          </td>
                          <td className="px-2 py-2 align-top text-xs text-zinc-400 tabular-nums">
                            {(importedPager.page - 1) * importedPager.pageSize + idx + 1}
                          </td>
                          {importedVisibleOrdered.map((k) =>
                            renderImportedCell(c, k),
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <PaginationBar
                  page={importedPager.page}
                  pageCount={importedPager.pageCount}
                  pageSize={importedPager.pageSize}
                  pageSizeOptions={importedPager.pageSizeOptions}
                  rangeLabel={importedPager.rangeLabel}
                  onPageChange={importedPager.setPage}
                  onPageSizeChange={importedPager.setPageSize}
                />
              </div>
            </div>
          </div>
        </section>
      </div>

      {importOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/45 p-4">
          <div className="mb-8 flex max-h-[92vh] w-[66.67vw] min-h-[min(70vh,720px)] max-w-[1200px] flex-col rounded-2xl border border-zinc-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-zinc-100 px-6 py-4">
              <div>
                <div className="text-sm font-semibold text-zinc-900">导入用例</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  已导入的用例会自动隐藏；支持模糊搜索与按迭代筛选。
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

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-[220px] flex-1">
                  <label className="text-[11px] font-medium text-zinc-500">
                    迭代筛选
                  </label>
                  <select
                    className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                    value={importIterCode}
                    onChange={(e) => setImportIterCode(e.target.value)}
                  >
                    {iterOptions.map((o) => (
                      <option key={o.code || "__baseline__"} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  disabled={importPickIds.length === 0}
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                  onClick={() => void doImport()}
                >
                  {importPickIds.length > 0
                    ? `导入已选（${importPickIds.length}）`
                    : "导入已选"}
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                  onClick={() => {
                    setImportIterCode("");
                    setImportQuery("");
                    setImportPickIds([]);
                  }}
                >
                  重置
                </button>
              </div>

              <div>
                <label className="text-xs font-medium text-zinc-600">
                  搜索用例
                </label>
                <input
                  type="search"
                  className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                  value={importQuery}
                  onChange={(e) => setImportQuery(e.target.value)}
                  placeholder="编号 / 名称（可选）；留空则列出当前迭代下用例"
                />
              </div>

              <div className="rounded-lg border border-zinc-200">
                <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
                  <span>可选用例（未导入 {importPendingRows.length} 条 / 最多 200）</span>
                  <span>{importLoading ? "加载中…" : ""}</span>
                </div>
                <div className="max-h-[420px] overflow-auto">
                  {importPendingRows.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-zinc-500">
                      {importLoading ? "加载中…" : "暂无可用用例（可能均已导入，或当前条件下无数据）。"}
                    </div>
                  ) : (
                    <table className="w-full min-w-[520px] table-fixed text-sm">
                      <colgroup>
                        <col style={{ width: importTblChkW }} />
                        <col style={{ width: importTblNoW }} />
                        <col style={{ width: importTblNameW }} />
                      </colgroup>
                      <thead className="sticky top-0 z-[1] border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                        <tr>
                          <th className="relative px-2 py-2 text-left font-medium">
                            <input
                              ref={importSelectAllRef}
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-zinc-300"
                              aria-label="全选可选用例"
                              onChange={() => toggleImportPickAll()}
                            />
                            <TableColumnResizeHandle
                              onResizeStart={startResizeImportChkVsNo}
                            />
                          </th>
                          <th className="relative px-2 py-2 text-left font-medium">
                            用例编号
                            <TableColumnResizeHandle
                              onResizeStart={startResizeImportNoVsName}
                            />
                          </th>
                          <th className="px-2 py-2 text-left font-medium">名称 / 目录</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {importPendingRows.map((c) => (
                          <tr
                            key={c.id}
                            className="cursor-pointer hover:bg-zinc-50/70"
                            onClick={() => toggleImportPick(c.id)}
                          >
                            <td
                              className="px-2 py-2 align-middle"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 rounded border-zinc-300"
                                checked={importPickSet.has(c.id)}
                                aria-label={`选择用例 ${c.caseNo}`}
                                onChange={() => toggleImportPick(c.id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </td>
                            <td className="px-2 py-2 font-mono text-xs text-zinc-700">
                              {c.caseNo}
                            </td>
                            <td className="px-2 py-2 text-zinc-800">
                              <div className="truncate">{c.title}</div>
                              {c.folderName ? (
                                <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                                  {c.folderName}
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <Suspense fallback={null}>
        <TestCaseLibraryClient
          embedMode
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

