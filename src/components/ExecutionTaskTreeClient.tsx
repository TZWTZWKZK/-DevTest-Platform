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
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  bulkDeleteExecutionTasks,
  bulkDuplicateExecutionTasks,
  bulkMoveExecutionTasksToIteration,
  createExecutionTaskNode,
  getGlobalExecutionIterationPreference,
  getGlobalIterationProductPreference,
  getExecutionTaskListColumnConfig,
  listExecutionTasksFlat,
  renameExecutionTaskNode,
  saveGlobalIterationProductPreference,
  saveGlobalExecutionIterationPreference,
  saveExecutionTaskListColumnConfig,
  type ExecutionTaskFlat,
} from "@/app/actions/executions";
import { listProductOptions, type ProductOption } from "@/app/actions/products";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import { TableColumnResizeHandle } from "@/components/TableColumnResizeHandle";
import {
  EXEC_TASK_COLUMN_LABELS,
  EXEC_TASK_COLUMN_KEYS,
  type ExecTaskColumnKey,
  useExecutionTaskColumns,
} from "@/hooks/useExecutionTaskColumns";
import { usePagination } from "@/hooks/usePagination";
import { useRowCheckboxBrushByIds } from "@/hooks/useRowCheckboxBrushByIds";
import { normalizeColumnOrder } from "@/lib/normalize-column-order";
import { buildTree, type TreeNode } from "@/lib/tree";

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

type IterOpt = { id: string; label: string; taskCount: number; productId: string };

function formatIterationOption(it: IterOpt): string {
  return `${it.label} · ${it.taskCount} 个任务`;
}

/** 比率：num/total（分母为 0 时按 0%） */
function formatExecProgress(executed: number, total: number): string {
  const pct = total === 0 ? 0 : Math.round((executed / total) * 100);
  return `${executed}/${total} (${pct}%)`;
}

function formatPassRate(passed: number, total: number): string {
  const pct = total === 0 ? 0 : Math.round((passed / total) * 100);
  return `${passed}/${total} (${pct}%)`;
}
type Node = TreeNode<ExecutionTaskFlat>;

function resolveInitialIterationId(
  iterations: IterOpt[],
  urlIterationId?: string,
): string {
  const u = urlIterationId?.trim();
  if (u && iterations.some((it) => it.id === u)) return u;
  return iterations[0]?.id ?? "";
}

type TaskRowMenuState = {
  taskId: string;
  title: string;
  x: number;
  y: number;
};

function clampExecRowMenuPosition(
  x: number,
  y: number,
  menuW: number,
  menuH: number,
) {
  const pad = 8;
  const maxX = typeof window !== "undefined" ? window.innerWidth - menuW - pad : x;
  const maxY = typeof window !== "undefined" ? window.innerHeight - menuH - pad : y;
  return {
    x: Math.max(pad, Math.min(x, maxX)),
    y: Math.max(pad, Math.min(y, maxY)),
  };
}

const EXEC_TREE_TOP_MAXIMIZED = -1;
const EXEC_TREE_TOP_DEFAULT_H = 168;
const EXEC_TREE_TOP_SNAP = 20;
const EXEC_TREE_RESIZE_H = 6;
const EXEC_TREE_MIN_TASK_H = 160;
const EXEC_TREE_LAYOUT_STORAGE = "pm.executionTaskTree.layout.v1";

type ExecTreeLayoutPersist = {
  topChromeH: number;
  topChromeLastNonZero: number;
};

const EXEC_TREE_LAYOUT_DEFAULTS: ExecTreeLayoutPersist = {
  topChromeH: EXEC_TREE_TOP_DEFAULT_H,
  topChromeLastNonZero: EXEC_TREE_TOP_DEFAULT_H,
};

function maxExecTopChromeHeight(workspaceH: number): number {
  return Math.max(96, workspaceH - EXEC_TREE_MIN_TASK_H - EXEC_TREE_RESIZE_H);
}

function parseExecTreeLayout(raw: unknown): ExecTreeLayoutPersist | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<ExecTreeLayoutPersist>;
  if (typeof o.topChromeH !== "number") return null;
  if (o.topChromeH !== EXEC_TREE_TOP_MAXIMIZED && o.topChromeH < 0) return null;
  const topChromeLastNonZero =
    typeof o.topChromeLastNonZero === "number" && o.topChromeLastNonZero > 0
      ? o.topChromeLastNonZero
      : EXEC_TREE_TOP_DEFAULT_H;
  return { topChromeH: o.topChromeH, topChromeLastNonZero };
}

function readExecTreeLayoutStorage(): ExecTreeLayoutPersist | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(EXEC_TREE_LAYOUT_STORAGE);
    if (!raw) return null;
    return parseExecTreeLayout(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveExecTreeLayoutStorage(data: ExecTreeLayoutPersist): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(EXEC_TREE_LAYOUT_STORAGE, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function ExecutionTaskTreeClient({
  initialIterations,
  initialIterationId,
}: {
  initialIterations: IterOpt[];
  /** 来自查询串，打开页时选中该迭代（与当前执行任务一致） */
  initialIterationId?: string;
}) {
  const router = useRouter();
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productId, setProductId] = useState("");
  const productPrefHydratedRef = useRef(false);
  const hasUrlIterationId = !!initialIterationId?.trim();
  const [iterationId, setIterationId] = useState(() =>
    resolveInitialIterationId(initialIterations, initialIterationId),
  );
  const iterationPrefHydratedRef = useRef(false);

  useEffect(() => {
    const u = initialIterationId?.trim();
    if (!u) return;
    const resolved = resolveInitialIterationId(initialIterations, u);
    if (!resolved) return;
    setIterationId((prev) => (prev === resolved ? prev : resolved));
  }, [initialIterationId, initialIterations]);

  useEffect(() => {
    if (hasUrlIterationId) return;
    let cancelled = false;
    void (async () => {
      const pref = await getGlobalExecutionIterationPreference();
      if (cancelled) return;
      const candidate = (pref.iterationId ?? "").trim();
      if (candidate && initialIterations.some((it) => it.id === candidate)) {
        setIterationId((prev) => (prev === candidate ? prev : candidate));
      }
      iterationPrefHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [hasUrlIterationId, initialIterations]);

  useEffect(() => {
    if (hasUrlIterationId || !iterationPrefHydratedRef.current) return;
    const t = window.setTimeout(() => {
      void saveGlobalExecutionIterationPreference({ iterationId });
    }, 400);
    return () => clearTimeout(t);
  }, [hasUrlIterationId, iterationId]);
  const [flat, setFlat] = useState<ExecutionTaskFlat[]>([]);
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
    const hit = initialIterations.find((it) => it.id === iterationId);
    if (hit?.productId) setProductId((prev) => prev || hit.productId);
  }, [initialIterations, iterationId]);

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

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const iterationLabel = useMemo(
    () =>
      visibleIterations.find((x) => x.id === iterationId)?.label ??
      (iterationId ? "当前迭代" : ""),
    [visibleIterations, iterationId],
  );

  const [createOpen, setCreateOpen] = useState(true);
  const [rootTitle, setRootTitle] = useState("");
  const [rootDesc, setRootDesc] = useState("");
  const [rootBusy, setRootBusy] = useState(false);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const workspaceLayoutRef = useRef<HTMLDivElement | null>(null);
  const topChromeRef = useRef<HTMLDivElement | null>(null);
  const topChromeLastNonZeroRef = useRef(EXEC_TREE_TOP_DEFAULT_H);
  const [topChromeH, setTopChromeH] = useState(EXEC_TREE_LAYOUT_DEFAULTS.topChromeH);
  const [layoutHydrated, setLayoutHydrated] = useState(false);

  useLayoutEffect(() => {
    const stored = readExecTreeLayoutStorage();
    if (stored) {
      topChromeLastNonZeroRef.current = stored.topChromeLastNonZero;
      setTopChromeH(stored.topChromeH);
    }
    setLayoutHydrated(true);
  }, []);

  useEffect(() => {
    if (!layoutHydrated) return;
    const layoutH = workspaceLayoutRef.current?.clientHeight ?? 0;
    if (layoutH <= 0) return;
    const maxTop = maxExecTopChromeHeight(layoutH);
    const clamped =
      topChromeH === EXEC_TREE_TOP_MAXIMIZED
        ? EXEC_TREE_TOP_MAXIMIZED
        : Math.min(maxTop, Math.max(0, topChromeH));
    if (clamped !== topChromeH) setTopChromeH(clamped);
    if (clamped > 0) topChromeLastNonZeroRef.current = clamped;
    const t = window.setTimeout(() => {
      saveExecTreeLayoutStorage({
        topChromeH: clamped,
        topChromeLastNonZero: topChromeLastNonZeroRef.current,
      });
    }, 350);
    return () => window.clearTimeout(t);
  }, [layoutHydrated, topChromeH]);

  const topChromeCollapsed = topChromeH === 0;
  const topChromeMaximized = topChromeH === EXEC_TREE_TOP_MAXIMIZED;

  const restoreTopChrome = useCallback(() => {
    setTopChromeH((cur) => {
      if (cur === EXEC_TREE_TOP_MAXIMIZED) {
        return Math.max(96, topChromeLastNonZeroRef.current || EXEC_TREE_TOP_DEFAULT_H);
      }
      if (cur > 0) {
        topChromeLastNonZeroRef.current = cur;
        return 0;
      }
      return Math.max(96, topChromeLastNonZeroRef.current || EXEC_TREE_TOP_DEFAULT_H);
    });
  }, []);

  const startResizeTopChrome = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture?.(e.pointerId);
      const sy = e.clientY;
      const layoutH = workspaceLayoutRef.current?.clientHeight ?? 0;
      const fullMax =
        layoutH > 0
          ? maxExecTopChromeHeight(layoutH)
          : EXEC_TREE_TOP_DEFAULT_H + 200;
      const h0 =
        topChromeH === EXEC_TREE_TOP_MAXIMIZED
          ? fullMax
          : topChromeH <= 0
            ? topChromeRef.current?.offsetHeight ?? EXEC_TREE_TOP_DEFAULT_H
            : topChromeH;
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - sy;
        const next = Math.min(fullMax, Math.max(0, h0 + dy));
        if (next <= 0) {
          setTopChromeH(0);
          return;
        }
        if (next >= fullMax - EXEC_TREE_TOP_SNAP) {
          if (next < fullMax) topChromeLastNonZeroRef.current = next;
          setTopChromeH(EXEC_TREE_TOP_MAXIMIZED);
          return;
        }
        topChromeLastNonZeroRef.current = next;
        setTopChromeH(next);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        try {
          el.releasePointerCapture?.(e.pointerId);
        } catch {
          // ignore
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [topChromeH],
  );

  const {
    config: colConfig,
    setConfig: setColConfig,
    visibleOrdered,
    setVisible,
    moveKey,
    setWidth,
    widthFor,
    defaultConfig,
  } = useExecutionTaskColumns();
  const resizeDrag = useRef<{
    key: ExecTaskColumnKey;
    startX: number;
    startW: number;
  } | null>(null);

  const [listTitleQ, setListTitleQ] = useState("");
  const [colPanelOpen, setColPanelOpen] = useState(false);
  const colPanelRef = useRef<HTMLDivElement | null>(null);
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const pickAllRef = useRef<HTMLInputElement | null>(null);
  const pickAllFullVisibleRef = useRef<HTMLInputElement | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [moveTargetIterId, setMoveTargetIterId] = useState("");
  const [taskRowMenu, setTaskRowMenu] = useState<TaskRowMenuState | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  const rowMenuDims = useRef({ w: 168, h: 96 });
  const [renameTaskModal, setRenameTaskModal] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameTaskDraft, setRenameTaskDraft] = useState("");
  const renameTaskInputRef = useRef<HTMLInputElement | null>(null);

  const parentIdsWithChildren = useMemo(() => {
    const s = new Set<string>();
    for (const r of flat) {
      if (r.parentId) s.add(r.parentId);
    }
    return s;
  }, [flat]);

  // 从数据库加载列配置（仅首次）
  useEffect(() => {
    void (async () => {
      const r = await getExecutionTaskListColumnConfig();
      if (r.config && typeof r.config === "object") {
        // 尽量容错：仅接收 order/visible/widths 三个字段
        const cfg = r.config as Partial<{
          order: ExecTaskColumnKey[];
          visible: Record<string, boolean>;
          widths: Record<string, number>;
        }>;
        const rawOrder = Array.isArray(cfg.order) ? cfg.order : defaultConfig.order;
        const order = normalizeColumnOrder(rawOrder, EXEC_TASK_COLUMN_KEYS);
        const visible: Record<ExecTaskColumnKey, boolean> = { ...defaultConfig.visible };
        if (cfg.visible && typeof cfg.visible === "object") {
          for (const k of EXEC_TASK_COLUMN_KEYS) {
            const v = (cfg.visible as Record<string, unknown>)[k];
            if (typeof v === "boolean") visible[k] = v;
          }
        }
        const widths: Partial<Record<ExecTaskColumnKey, number>> = {};
        if (cfg.widths && typeof cfg.widths === "object") {
          for (const k of EXEC_TASK_COLUMN_KEYS) {
            const w = (cfg.widths as Record<string, unknown>)[k];
            if (typeof w === "number" && Number.isFinite(w)) widths[k] = w;
          }
        }
        setColConfig({ order, visible, widths });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 保存到数据库：列配置变化后防抖写入
  useEffect(() => {
    const t = window.setTimeout(() => {
      void saveExecutionTaskListColumnConfig({ config: colConfig });
    }, 450);
    return () => clearTimeout(t);
  }, [colConfig]);

  useEffect(() => {
    if (!colPanelOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = colPanelRef.current;
      if (!el) return;
      const t = e.target as unknown;
      if (!(t instanceof Element)) return;
      if (!el.contains(t)) setColPanelOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [colPanelOpen]);

  const reload = useCallback(async () => {
    if (!iterationId) {
      setFlat([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const rows = await listExecutionTasksFlat(iterationId);
      setFlat(rows);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [iterationId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setPickedIds([]);
    setMoveTargetIterId("");
  }, [iterationId]);

  useLayoutEffect(() => {
    if (!taskRowMenu || !rowMenuRef.current) return;
    const r = rowMenuRef.current.getBoundingClientRect();
    rowMenuDims.current = { w: r.width, h: r.height };
  }, [taskRowMenu]);

  useEffect(() => {
    if (!taskRowMenu) return;
    const onDoc = (e: MouseEvent | PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (rowMenuRef.current?.contains(e.target)) return;
      setTaskRowMenu(null);
    };
    document.addEventListener("pointerdown", onDoc, true);
    return () => document.removeEventListener("pointerdown", onDoc, true);
  }, [taskRowMenu]);

  useEffect(() => {
    if (!renameTaskModal) return;
    const t = window.setTimeout(() => renameTaskInputRef.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRenameTaskModal(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
  }, [renameTaskModal]);

  const closeRowMenu = useCallback(() => setTaskRowMenu(null), []);

  const openTaskRowMenu = useCallback(
    (n: ExecutionTaskFlat, anchor: HTMLElement) => {
      const rect = anchor.getBoundingClientRect();
      const { w, h } = rowMenuDims.current;
      const rawX = rect.right - w;
      const rawY = rect.bottom + 4;
      const p = clampExecRowMenuPosition(rawX, rawY, w, h);
      setTaskRowMenu({
        taskId: n.id,
        title: n.title,
        x: p.x,
        y: p.y,
      });
    },
    [],
  );

  const submitRenameTask = useCallback(async () => {
    const m = renameTaskModal;
    if (!m) return;
    const title = renameTaskDraft.trim();
    if (!title) {
      setErr("任务名称不能为空。");
      return;
    }
    if (title === m.title) {
      setRenameTaskModal(null);
      return;
    }
    setRenameTaskModal(null);
    setErr(null);
    const r = await renameExecutionTaskNode({ id: m.id, title });
    if (r.error) {
      setErr(r.error);
      return;
    }
    await reload();
  }, [renameTaskDraft, renameTaskModal, reload]);

  const runRowDelete = useCallback(
    async (id: string, title: string) => {
      closeRowMenu();
      if (parentIdsWithChildren.has(id)) {
        const msg = `无法删除：「${title}」仍有子任务，请先处理子任务后再删父任务。`;
        window.alert(msg);
        setErr(msg);
        return;
      }
      const row = flat.find((r) => r.id === id);
      if (row && row.linkedCaseCount > 0) {
        const msg = `无法删除：「${title}」仍有关联的已导入用例，请先在任务详情中移除用例后再删。`;
        window.alert(msg);
        setErr(msg);
        return;
      }
      if (
        !window.confirm(
          `确定删除任务「${title}」？需无子任务且无已导入用例；删除后该任务下历史执行记录将一并删除。`,
        )
      ) {
        return;
      }
      setErr(null);
      const r = await bulkDeleteExecutionTasks({ ids: [id] });
      if (r.error) {
        setErr(r.error);
        window.alert(r.error);
        return;
      }
      setPickedIds((prev) => prev.filter((x) => x !== id));
      await reload();
    },
    [closeRowMenu, flat, parentIdsWithChildren, reload],
  );

  const filteredFlat = useMemo(() => {
    const q = listTitleQ.trim().toLowerCase();
    return flat.filter((r) => {
      if (q && !r.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [listTitleQ, flat]);

  const tree = useMemo(() => buildTree(filteredFlat), [filteredFlat]);
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
    walk(tree, 0);
    return out;
  }, [expanded, tree]);
  const rowPager = usePagination(visibleRows, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.executions",
  });
  const pagedRows = rowPager.pagedItems;
  const pagedVisibleIds = useMemo(() => pagedRows.map((x) => x.n.id), [pagedRows]);
  const allTaskVisibleRowIds = useMemo(
    () => visibleRows.map(({ n }) => n.id),
    [visibleRows],
  );
  const pagedTaskPickRowIdsRef = useRef<string[]>([]);
  pagedTaskPickRowIdsRef.current = pagedVisibleIds;
  const pickedIdsRef = useRef(pickedIds);
  pickedIdsRef.current = pickedIds;
  const { onRowCheckboxPointerDown, tableBodyRef: taskPickTableBodyRef } =
    useRowCheckboxBrushByIds({
      pagedRowIdsRef: pagedTaskPickRowIdsRef,
      selectedIdsRef: pickedIdsRef,
      setSelectedIds: setPickedIds,
    });
  const pickedSet = useMemo(() => new Set(pickedIds), [pickedIds]);

  useEffect(() => {
    const el = pickAllRef.current;
    if (!el) return;
    if (pickedIds.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    if (pagedVisibleIds.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const allSelected = pagedVisibleIds.every((id) => pickedSet.has(id));
    el.indeterminate = !allSelected && pickedIds.length > 0;
    el.checked = allSelected;
  }, [pagedVisibleIds, pickedIds.length, pickedSet]);

  useEffect(() => {
    const el = pickAllFullVisibleRef.current;
    if (!el) return;
    const ids = allTaskVisibleRowIds;
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
  }, [allTaskVisibleRowIds, pickedIds]);

  const togglePickAll = useCallback(() => {
    if (pagedVisibleIds.length === 0) return;
    setPickedIds((prev) => {
      const prevSet = new Set(prev);
      const allSelected = pagedVisibleIds.every((id) => prevSet.has(id));
      if (allSelected) return prev.filter((id) => !new Set(pagedVisibleIds).has(id));
      return Array.from(new Set([...prev, ...pagedVisibleIds]));
    });
  }, [pagedVisibleIds]);

  const togglePickAllFullVisible = useCallback(() => {
    const ids = allTaskVisibleRowIds;
    if (ids.length === 0) return;
    setPickedIds((prev) => {
      const fullSet = new Set(ids);
      const exact =
        prev.length === ids.length &&
        prev.every((id) => fullSet.has(id));
      if (exact) return [];
      return [...ids];
    });
  }, [allTaskVisibleRowIds]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
  };

  const expandAll = () => {
    const next: Record<string, boolean> = {};
    for (const r of flat) next[r.id] = true;
    setExpanded(next);
  };

  const runBulkDelete = useCallback(async () => {
    if (pickedIds.length === 0 || !iterationId) return;
    const rowById = new Map(flat.map((r) => [r.id, r]));
    const blockedChildren = pickedIds.filter((id) =>
      parentIdsWithChildren.has(id),
    );
    if (blockedChildren.length > 0) {
      const names = blockedChildren
        .map((id) => rowById.get(id)?.title ?? id)
        .slice(0, 8);
      const suffix =
        blockedChildren.length > 8
          ? ` …（共 ${blockedChildren.length} 项仍有子任务）`
          : "";
      const msg = `无法删除：以下任务仍有子任务，请先删除或移走子任务后再删父任务。${names.map((t) => `「${t}」`).join("、")}${suffix}`;
      window.alert(msg);
      setErr(msg);
      return;
    }
    const blockedLinked = pickedIds.filter((id) => {
      const row = rowById.get(id);
      return row != null && row.linkedCaseCount > 0;
    });
    if (blockedLinked.length > 0) {
      const names = blockedLinked
        .map((id) => rowById.get(id)?.title ?? id)
        .slice(0, 8);
      const suffix =
        blockedLinked.length > 8
          ? ` …（共 ${blockedLinked.length} 项已导入用例）`
          : "";
      const msg = `无法删除：以下任务仍有关联的已导入用例，请先在任务详情中移除用例后再删任务。${names.map((t) => `「${t}」`).join("、")}${suffix}`;
      window.alert(msg);
      setErr(msg);
      return;
    }
    if (
      !window.confirm(
        `确定删除已选 ${pickedIds.length} 项任务？需「无子任务、无已导入用例」；删除后各任务下历史执行记录将一并删除。`,
      )
    )
      return;
    setBatchBusy(true);
    setErr(null);
    const r = await bulkDeleteExecutionTasks({ ids: pickedIds });
    setBatchBusy(false);
    if (r.error) {
      window.alert(r.error);
      setErr(r.error);
      return;
    }
    setPickedIds([]);
    await reload();
  }, [flat, iterationId, parentIdsWithChildren, pickedIds, reload]);

  const runBulkDuplicate = useCallback(async () => {
    if (pickedIds.length === 0 || !iterationId) return;
    setBatchBusy(true);
    setErr(null);
    const r = await bulkDuplicateExecutionTasks({ iterationId, ids: pickedIds });
    setBatchBusy(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    setPickedIds([]);
    await reload();
    expandAll();
  }, [iterationId, pickedIds, reload]);

  const runBulkMove = useCallback(async () => {
    if (pickedIds.length === 0 || !moveTargetIterId) return;
    const label =
      visibleIterations.find((x) => x.id === moveTargetIterId)?.label ?? "目标迭代";
    if (
      !window.confirm(
        `将已选 ${pickedIds.length} 项任务（含子树）转移到「${label}」？`,
      )
    )
      return;
    setBatchBusy(true);
    setErr(null);
    const r = await bulkMoveExecutionTasksToIteration({
      ids: pickedIds,
      targetIterationId: moveTargetIterId,
    });
    setBatchBusy(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    setPickedIds([]);
    setMoveTargetIterId("");
    await reload();
  }, [visibleIterations, moveTargetIterId, pickedIds, reload]);

  const createRoot = async () => {
    if (!iterationId) return;
    const title = rootTitle.trim();
    if (!title) return;
    setRootBusy(true);
    try {
      const r = await createExecutionTaskNode({
        iterationId,
        parentId: null,
        title,
        description: rootDesc.trim() || null,
      });
      if (r.error) {
        setErr(r.error);
        return;
      }
      setRootTitle("");
      setRootDesc("");
      await reload();
      expandAll();
      // 尽量把新建区域保持可见
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setRootBusy(false);
    }
  };

  const startResize = useCallback((key: ExecTaskColumnKey, startX: number) => {
    resizeDrag.current = { key, startX, startW: widthFor(key) };
    const onMove = (e: globalThis.MouseEvent) => {
      const drag = resizeDrag.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      setWidth(drag.key, drag.startW + dx);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      resizeDrag.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [setWidth, widthFor]);

  const renderRow = (n: Node, depth: number): ReactElement => {
    const open = expanded[n.id] ?? true;
    const hasChildren = n.children.length > 0;
    return (
      <tr
        key={n.id}
        data-pm-row-select={n.id}
        className="cursor-pointer hover:bg-zinc-50/70"
        onClick={() => router.push(`/executions/task/${n.id}`)}
      >
        <td className="px-3 py-2 align-top">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-zinc-300"
            checked={pickedSet.has(n.id)}
            onChange={() => {}}
            onClick={(e) => e.preventDefault()}
            onPointerDown={(e) => onRowCheckboxPointerDown(e, n.id)}
            onKeyDown={(e) => {
              if (e.key !== " " && e.key !== "Enter") return;
              e.preventDefault();
              e.stopPropagation();
              setPickedIds((prev) =>
                prev.includes(n.id)
                  ? prev.filter((x) => x !== n.id)
                  : [...prev, n.id],
              );
            }}
            title="按住并拖动经过多行可连续勾选"
            aria-label="选择该行"
          />
        </td>
        {visibleOrdered.map((k) => {
          switch (k) {
            case "title":
              return (
                <td key={k} className="px-3 py-2 align-top">
                  <div
                    className="flex min-w-0 items-start gap-2"
                    style={{ paddingLeft: depth * 16 }}
                  >
                    <button
                      type="button"
                      className="mt-0.5 shrink-0 rounded px-0.5 py-0.5 text-sm leading-none text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900"
                      title="操作：重命名、删除"
                      aria-label={`${n.title} 操作菜单`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openTaskRowMenu(n, e.currentTarget);
                      }}
                    >
                      ⋮
                    </button>
                    <button
                      type="button"
                      className={[
                        "mt-0.5 h-5 w-5 shrink-0 rounded border border-zinc-200 bg-white text-[11px] leading-none text-zinc-600 hover:bg-zinc-50",
                        hasChildren ? "" : "opacity-0 pointer-events-none",
                      ].join(" ")}
                      aria-label={open ? "收起" : "展开"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleExpand(n.id);
                      }}
                    >
                      {open ? "−" : "+"}
                    </button>
                    <div className="min-w-0">
                      <Link
                        href={`/executions/task/${n.id}`}
                        className="block truncate font-medium text-zinc-900 hover:underline"
                        title={n.title}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {n.title}
                      </Link>
                      {n.description ? (
                        <div className="mt-0.5 truncate text-xs text-zinc-500">
                          {n.description}
                        </div>
                      ) : null}
                    </div>
                  </div>
                </td>
              );
            case "linkedCaseCount":
              return (
                <td
                  key={k}
                  className="px-3 py-2 align-top text-xs text-zinc-600 tabular-nums"
                  title="执行情况：状态不为空/用例总数。这里“状态不为空”按该任务下该用例的执行结果不为空判定；括号为占比（四舍五入取整）。"
                >
                  {formatExecProgress(
                    Math.max(0, n.linkedCaseCount - (n.latestStatusCounts?.NONE ?? 0)),
                    n.linkedCaseCount,
                  )}
                </td>
              );
            case "passRate":
              return (
                <td
                  key={k}
                  className="px-3 py-2 align-top text-xs text-zinc-600 tabular-nums"
                  title="通过率：成功/用例总数。成功=该任务下该用例最近一次执行状态为「通过」「废弃」或「转需求」；括号为成功占比（四舍五入取整）。"
                >
                  {formatPassRate(n.passedCaseCount, n.linkedCaseCount)}
                </td>
              );
            case "createdBy":
              return (
                <td key={k} className="px-3 py-2 align-top text-xs text-zinc-600">
                  <span className="block truncate">{n.createdBy ?? "—"}</span>
                </td>
              );
            case "updatedBy":
              return (
                <td key={k} className="px-3 py-2 align-top text-xs text-zinc-600">
                  <span className="block truncate">{n.updatedBy ?? "—"}</span>
                </td>
              );
            case "updatedAt":
              return (
                <td
                  key={k}
                  className="px-3 py-2 align-top text-xs text-zinc-500 tabular-nums"
                >
                  {formatTs(n.updatedAt)}
                </td>
              );
            default:
              return (
                <td key={k} className="px-3 py-2 align-top text-xs text-zinc-500">
                  —
                </td>
              );
          }
        })}
      </tr>
    );
  };

  return (
    <>
    <ModuleWorkspaceCard>
      <div
        ref={workspaceLayoutRef}
        className="flex max-h-[calc(100dvh-11rem)] min-h-[70vh] flex-col overflow-hidden"
      >
        {!topChromeCollapsed ? (
          <div
            ref={topChromeRef}
            className={[
              "flex shrink-0 flex-col overflow-y-auto overflow-x-hidden",
              topChromeMaximized ? "min-h-0 flex-1" : "",
            ].join(" ")}
            style={
              topChromeMaximized || topChromeH <= 0
                ? undefined
                : { height: topChromeH, minHeight: 0 }
            }
          >
            <div className="shrink-0 border-b border-zinc-200 bg-zinc-50/60 px-3 py-2 sm:px-4">
              <div className="flex flex-wrap items-end gap-3 gap-y-2">
                <div className="min-w-[min(100%,12rem)] flex-1 sm:flex-initial sm:min-w-[220px]">
                  <label className="text-xs font-medium text-zinc-600">所属产品</label>
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
                  <label className="text-xs font-medium text-zinc-600">所属迭代</label>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <select
                      className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm sm:max-w-[min(100%,32rem)]"
                      value={iterationId}
                      onChange={(e) => setIterationId(e.target.value)}
                    >
                      {visibleIterations.length === 0 ? (
                        <option value="">暂无迭代，请先在「产品管理」中创建</option>
                      ) : (
                        visibleIterations.map((it) => (
                          <option key={it.id} value={it.id}>
                            {formatIterationOption(it)}
                          </option>
                        ))
                      )}
                    </select>
                    {iterationId ? (
                      <span
                        className="shrink-0 text-xs tabular-nums text-zinc-600"
                        title="当前迭代下任务数量（与下方列表一致；新建或删除后随列表更新）"
                      >
                        {loading ? (
                          <span className="text-zinc-400">加载中…</span>
                        ) : (
                          <>已有任务 {flat.length} 个</>
                        )}
                      </span>
                    ) : null}
                  </div>
                </div>
                <p className="hidden max-w-xl pb-0.5 text-[11px] leading-snug text-zinc-500 sm:block">
                  先选择<strong>所属迭代</strong>，再在下方表格维护执行任务；点击<strong>任务名称</strong>进入详情导入用例。
                </p>
              </div>
              {!iterationId ? (
                <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                  没有可选迭代时，请先创建产品与迭代。
                </p>
              ) : null}
            </div>

            <div className="shrink-0 border-b border-zinc-100 bg-white px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-900">
                    当前：{iterationLabel}
                  </h2>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    表格包含当前迭代下全部执行任务；点击行进入详情；行首 <strong>⋮</strong>{" "}
                    可重命名、删除（须无子任务且无已导入用例）。表头竖线可拖动调宽。
                  </p>
                </div>
                <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCreateOpen((o) => !o)}
                    className={MODULE_TOOLBAR_BTN_PRIMARY}
                    disabled={!iterationId}
                  >
                    + 新建执行任务
                  </button>
                  <div className="w-[min(100%,220px)] sm:w-[220px]">
                    <input
                      type="search"
                      className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      placeholder="模糊查询：任务名称"
                      value={listTitleQ}
                      onChange={(e) => setListTitleQ(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <div
          role="separator"
          aria-label="拖动调整筛选区与任务列表高度"
          title={
            topChromeCollapsed
              ? "向下拖展开产品/迭代筛选与工具栏"
              : topChromeMaximized
                ? "向上拖展开任务列表"
                : "拖动调整高度（向上扩大任务列表，向下扩大筛选区；双击切换收展）"
          }
          className="relative z-20 h-1.5 shrink-0 cursor-row-resize border-y border-transparent hover:border-zinc-200 hover:bg-sky-500/10"
          onPointerDown={startResizeTopChrome}
          onDoubleClick={() => restoreTopChrome()}
        />

        {!topChromeMaximized ? (
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-4">
            {!iterationId ? (
              <p className="text-sm text-zinc-500">请先在上方选择所属迭代。</p>
            ) : (
              <>
                {createOpen ? (
                  <div className="mb-3 rounded-lg border border-zinc-100 bg-zinc-50/50 p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      新建执行任务（根节点）
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        className="min-w-[180px] flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        placeholder="任务名称"
                        value={rootTitle}
                        onChange={(e) => setRootTitle(e.target.value)}
                      />
                      <input
                        className="min-w-[220px] flex-[2] rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        placeholder="描述（可选）"
                        value={rootDesc}
                        onChange={(e) => setRootDesc(e.target.value)}
                      />
                      <button
                        type="button"
                        disabled={rootBusy || rootTitle.trim().length === 0}
                        onClick={() => void createRoot()}
                        className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                      >
                        {rootBusy ? "新建中…" : "新建"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCreateOpen(false)}
                        className="text-sm text-zinc-500 hover:underline"
                      >
                        收起
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="flex min-h-0 flex-1 flex-col bg-white">
                  {err ? (
                    <div className="border-b border-red-100 bg-red-50 px-3 py-2 text-sm text-red-800">
                      {err}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
                    <span>
                      {loading
                        ? "加载中…"
                        : `共 ${filteredFlat.length} 条（筛选后）`}
                    </span>
                    <div className="flex items-center gap-2">
                      <div className="relative" ref={colPanelRef}>
                        <button
                          type="button"
                          className="rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm text-zinc-700 shadow-sm hover:bg-zinc-50"
                          title="列表列设置（显隐、顺序；表头可拖竖线调宽）"
                          aria-expanded={colPanelOpen}
                          aria-haspopup="true"
                          aria-label="执行任务列表列设置"
                          onClick={() => setColPanelOpen((o) => !o)}
                        >
                          ⚙
                        </button>
                        {colPanelOpen ? (
                          <div
                            className="absolute right-0 top-[calc(100%+8px)] z-20 w-[320px] rounded-xl border border-zinc-200 bg-white p-2 shadow-xl"
                            role="dialog"
                            aria-label="列设置"
                          >
                            <div
                              className="px-2 pb-2 text-xs font-medium text-zinc-500"
                              aria-label="列设置标题"
                            >
                              列设置
                            </div>
                            <div className="max-h-[min(70vh,28rem)] overflow-y-auto p-1">
                              {colConfig.order.map((key, idx) => (
                                <div
                                  key={key}
                                  className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-zinc-50"
                                >
                                  <input
                                    id={`exec-col-${key}`}
                                    type="checkbox"
                                    className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                    checked={colConfig.visible[key] !== false}
                                    onChange={(e) => setVisible(key, e.target.checked)}
                                  />
                                  <label
                                    htmlFor={`exec-col-${key}`}
                                    className="min-w-0 flex-1 cursor-pointer text-sm text-zinc-800"
                                  >
                                    {EXEC_TASK_COLUMN_LABELS[key]}
                                  </label>
                                  <div className="flex shrink-0 gap-0.5">
                                    <button
                                      type="button"
                                      className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-600 disabled:opacity-30"
                                      disabled={idx === 0}
                                      title="上移"
                                      onClick={() => moveKey(key, -1)}
                                    >
                                      ↑
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-600 disabled:opacity-30"
                                      disabled={idx === colConfig.order.length - 1}
                                      title="下移"
                                      onClick={() => moveKey(key, 1)}
                                    >
                                      ↓
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-100 pt-2">
                              <button
                                type="button"
                                className="rounded-lg border border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                                onClick={() => setColConfig(defaultConfig)}
                              >
                                重置默认
                              </button>
                              <button
                                type="button"
                                className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white"
                                onClick={() => setColPanelOpen(false)}
                              >
                                关闭
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                        onClick={() => void reload()}
                      >
                        刷新
                      </button>
                    </div>
                  </div>

                  {pickedIds.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 bg-sky-50/80 px-3 py-2 text-sm text-zinc-800">
                      <span>
                        已选{" "}
                        <strong className="tabular-nums">{pickedIds.length}</strong>{" "}
                        条
                      </span>
                      <button
                        type="button"
                        disabled={batchBusy}
                        className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                        onClick={() => void runBulkDuplicate()}
                      >
                        批量复制
                      </button>
                      <button
                        type="button"
                        disabled={batchBusy}
                        className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-800 hover:bg-red-50 disabled:opacity-50"
                        onClick={() => void runBulkDelete()}
                      >
                        批量删除
                      </button>
                      <span className="hidden text-zinc-300 sm:inline">|</span>
                      <label className="text-xs text-zinc-600">转移至</label>
                      <select
                        className="max-w-[min(100vw,280px)] rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs"
                        value={moveTargetIterId}
                        disabled={batchBusy || visibleIterations.length < 2}
                        onChange={(e) => setMoveTargetIterId(e.target.value)}
                      >
                        <option value="">选择目标迭代…</option>
                        {visibleIterations
                          .filter((it) => it.id !== iterationId)
                          .map((it) => (
                            <option key={it.id} value={it.id}>
                              {formatIterationOption(it)}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        disabled={
                          batchBusy || !moveTargetIterId || !iterationId
                        }
                        className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                        onClick={() => void runBulkMove()}
                      >
                        转移
                      </button>
                      <button
                        type="button"
                        className="ml-auto text-xs text-zinc-500 underline hover:text-zinc-800"
                        disabled={batchBusy}
                        onClick={() => setPickedIds([])}
                      >
                        取消选择
                      </button>
                    </div>
                  ) : null}

                  <div
                    ref={scrollRef}
                    className="min-h-0 flex-1 overflow-auto"
                  >
                    {visibleRows.length === 0 ? (
                      <div className="px-3 py-3 text-sm text-zinc-500">
                        {loading ? "加载中…" : "暂无执行任务，请先新建。"}
                      </div>
                    ) : (
                      <table className="w-max min-w-[760px] table-fixed text-sm">
                        <colgroup>
                          <col style={{ width: 60 }} />
                          {visibleOrdered.map((k) => (
                            <col key={k} style={{ width: widthFor(k) }} />
                          ))}
                        </colgroup>
                        <thead className="sticky top-0 z-[1] border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                          <tr>
                            <th className="min-w-[3.75rem] px-2 py-2 text-left font-medium">
                              <div className="flex items-end justify-start gap-1">
                                <input
                                  ref={pickAllRef}
                                  type="checkbox"
                                  className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    togglePickAll();
                                  }}
                                  title="全选当前页（可与其它页已选合并）"
                                  aria-label="全选当前页"
                                />
                                <input
                                  ref={pickAllFullVisibleRef}
                                  type="checkbox"
                                  className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                  onChange={(e) => {
                                    e.stopPropagation();
                                    togglePickAllFullVisible();
                                  }}
                                  title="全选列表：选中当前筛选下全部任务（与分页「/ 总数」一致）"
                                  aria-label="全选全部可见任务"
                                />
                              </div>
                            </th>
                            {visibleOrdered.map((k) => {
                              const label = EXEC_TASK_COLUMN_LABELS[k];
                              const isLast = visibleOrdered[visibleOrdered.length - 1] === k;
                              return (
                                <th
                                  key={k}
                                  className={[
                                    "px-3 py-2 text-left font-medium",
                                    isLast ? "" : "relative",
                                  ].join(" ")}
                                >
                                  {label}
                                  {!isLast ? (
                                    <TableColumnResizeHandle
                                      onResizeStart={(e) => startResize(k, e.clientX)}
                                    />
                                  ) : null}
                                </th>
                              );
                            })}
                          </tr>
                        </thead>
                        <tbody
                          ref={taskPickTableBodyRef}
                          className="divide-y divide-zinc-100"
                        >
                          {pagedRows.map(({ n, depth }) => renderRow(n, depth))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <div className="shrink-0 border-t border-zinc-100/80">
                    <PaginationBar
                      page={rowPager.page}
                      pageCount={rowPager.pageCount}
                      pageSize={rowPager.pageSize}
                      pageSizeOptions={rowPager.pageSizeOptions}
                      rangeLabel={rowPager.rangeLabel}
                      onPageChange={rowPager.setPage}
                      onPageSizeChange={rowPager.setPageSize}
                      className="!mt-0 w-full justify-end px-3 pb-2 pt-3"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
        ) : null}
      </div>
    </ModuleWorkspaceCard>

    {taskRowMenu ? (
      <div
        ref={rowMenuRef}
        className="fixed z-[200] min-w-[10.5rem] rounded-lg border border-zinc-200 bg-white py-1 text-sm shadow-lg"
        style={{ top: taskRowMenu.y, left: taskRowMenu.x }}
        role="menu"
      >
        <button
          type="button"
          role="menuitem"
          className="block w-full px-3 py-2 text-left hover:bg-zinc-100"
          onClick={() => {
            setRenameTaskDraft(taskRowMenu.title);
            setRenameTaskModal({
              id: taskRowMenu.taskId,
              title: taskRowMenu.title,
            });
            closeRowMenu();
          }}
        >
          重命名
        </button>
        <button
          type="button"
          role="menuitem"
          className="block w-full px-3 py-2 text-left text-red-700 hover:bg-red-50"
          onClick={() => void runRowDelete(taskRowMenu.taskId, taskRowMenu.title)}
        >
          删除
        </button>
      </div>
    ) : null}

    {renameTaskModal ? (
      <div
        className="fixed inset-0 z-[210] flex items-center justify-center bg-black/45 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="exec-rename-task-title"
        onClick={() => setRenameTaskModal(null)}
      >
        <div
          className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2
            id="exec-rename-task-title"
            className="text-base font-semibold text-zinc-900"
          >
            重命名执行任务
          </h2>
          <label className="mt-3 block text-xs font-medium text-zinc-600">
            任务名称
          </label>
          <input
            ref={renameTaskInputRef}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            value={renameTaskDraft}
            onChange={(e) => setRenameTaskDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRenameTask();
            }}
          />
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              onClick={() => setRenameTaskModal(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-800"
              onClick={() => void submitRenameTask()}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

