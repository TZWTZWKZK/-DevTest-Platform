"use client";

import type React from "react";
import type { TestDesignType } from "@prisma/client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  bulkDeleteTestDesignNodes,
  bulkDuplicateTestDesignNodes,
  bulkMoveTestDesignNodes,
  bulkMoveAllTestDesignsBetweenRequirements,
  bulkUpdateTestDesignNodes,
  countTestDesignByDirSubtree,
  countTestDesignByDirSubtreeForRequirements,
  countTestDesignsForCategoryHide,
  createTestDesignDir,
  createTestDesignNode,
  countTestDesignByRequirement,
  countTestDesignByType,
  countTestDesignByTypeForRequirements,
  deleteTestDesignNode,
  deleteTestDesignDir,
  getTestDesignFlat,
  getTestDesignFlatForRequirements,
  getTestDesignsExportRows,
  listTestDesignDirs,
  listRequirementsForDesignTree,
  moveTestDesignDir,
  renameTestDesignDir,
  type RequirementTreeFlat,
  type TestDesignFlat,
} from "@/app/actions/test-design";
import {
  getGlobalIterationProductPreference,
  getGlobalTestDesignIterationPreference,
  getGlobalTestDesignLayoutPreference,
  getTestDesignReqTreeExpandPreference,
  saveGlobalIterationProductPreference,
  saveGlobalTestDesignIterationPreference,
  saveGlobalTestDesignLayoutPreference,
  saveTestDesignReqTreeExpandPreference,
  type TestDesignLayoutPreference,
} from "@/app/actions/executions";
import { listProductOptions, type ProductOption } from "@/app/actions/products";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import {
  isTestDesignColumnPinned,
  TEST_DESIGN_COLUMN_LABELS,
  useTestDesignListColumns,
  type TestDesignColumnKey,
} from "@/hooks/useTestDesignListColumns";
import { usePagination } from "@/hooks/usePagination";
import { useRowCheckboxBrushByIds } from "@/hooks/useRowCheckboxBrushByIds";
import { testDesignTypeLabel, testDesignTypeOptions } from "@/lib/test-labels";
import { compareWbsId } from "@/lib/wbs-id";
import { buildTree, type TreeNode } from "@/lib/tree";

import {
  clearPendingTestDesignImport,
  writePendingTestDesignImport,
} from "@/lib/pendingTestDesignImport";
const TEST_DESIGN_TREE_CONTEXT_STORAGE = "pm-test-design-tree-context";

/** 关联用例列表头筛选（当前选项展示于 title） */
const LINKED_CASES_HEADER_FILTER_LABEL: Record<
  "all" | "linked" | "unlinked",
  string
> = {
  all: "全部",
  linked: "已关联",
  unlinked: "未关联",
};

const LINKED_CASES_HEADER_CHEVRON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E";

type Node = TreeNode<TestDesignFlat>;
type ReqNode = TreeNode<RequirementTreeFlat>;

function collectReqSubtreeIds(
  rootId: string,
  flat: RequirementTreeFlat[],
): string[] {
  if (!rootId) return [];
  const children = new Map<string, string[]>();
  for (const r of flat) {
    if (!r.parentId) continue;
    const arr = children.get(r.parentId) ?? [];
    arr.push(r.id);
    children.set(r.parentId, arr);
  }
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const cid of children.get(cur) ?? []) stack.push(cid);
  }
  return out;
}

/** 展开需求树中通往 requirementId 的各级父节点 */
function expandRequirementAncestors(
  requirementId: string,
  flat: RequirementTreeFlat[],
): Record<string, boolean> {
  const byId = new Map(flat.map((r) => [r.id, r]));
  const patch: Record<string, boolean> = { [requirementId]: true };
  let cur = byId.get(requirementId);
  while (cur?.parentId) {
    patch[cur.parentId] = true;
    cur = byId.get(cur.parentId);
  }
  return patch;
}

function parseDesignTypeParam(raw: string): TestDesignType | null {
  const t = raw.trim();
  if (!t) return null;
  return testDesignTypeOptions.some((o) => o.value === t)
    ? (t as TestDesignType)
    : null;
}

/** 展开侧栏目录树中通往 dirId 的各级父节点 */
function expandCustomDirAncestors(
  dirId: string,
  dirs: CustomDir[],
): Record<string, boolean> {
  const byId = new Map(dirs.map((d) => [d.id, d]));
  const patch: Record<string, boolean> = { [dirId]: true };
  let cur = byId.get(dirId);
  while (cur?.parentId) {
    patch[cur.parentId] = true;
    cur = byId.get(cur.parentId);
  }
  return patch;
}

/** 仅保留当前需求列表中仍存在的节点 id（切换迭代或刷新树时用） */
function filterReqExpandToKnownIds(
  exp: Record<string, boolean>,
  reqFlat: RequirementTreeFlat[],
): Record<string, boolean> {
  const idSet = new Set(reqFlat.map((r) => r.id));
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(exp)) {
    if (idSet.has(k) && typeof v === "boolean") out[k] = v;
  }
  return out;
}

function expandDefaultsForRoots(
  base: Record<string, boolean>,
  reqFlat: RequirementTreeFlat[],
): Record<string, boolean> {
  const next = { ...base };
  for (const r of reqFlat) {
    if (!r.parentId && next[r.id] === undefined) next[r.id] = true;
  }
  return next;
}

type CategoryItem = {
  key: TestDesignType;
  label: string;
  hidden?: boolean;
};

const CATEGORY_STORAGE_KEY = "pm-test-design-categories-v1";
const LAYOUT_STORAGE_KEY = "pm-test-design-layout-v1";
const TOP_PANE_DEFAULT_H = 138;
/** 需求目录独占全屏（隐藏下方设计区） */
const TOP_PANE_MAXIMIZED = -1;
const TOP_PANE_RESIZE_H = 8;
const TOP_PANE_SNAP_THRESHOLD = 4;
/** 右侧设计表格区域至少保留高度 */
const MIN_DESIGN_LIST_AREA_H = 200;
const TOP_PANE_VIEWPORT_CHROME = 140;

function maxTopPaneHeightFromLayout(layoutHeight: number): number {
  return Math.max(96, layoutHeight - TOP_PANE_RESIZE_H);
}

function maxTopPaneHeight(): number {
  if (typeof window === "undefined") return 480;
  return Math.max(
    96,
    Math.floor(window.innerHeight - TOP_PANE_VIEWPORT_CHROME - TOP_PANE_RESIZE_H),
  );
}

function maxListToolbarHeight(parentClientHeight: number): number {
  return Math.max(0, parentClientHeight - MIN_DESIGN_LIST_AREA_H);
}

function clampLayoutPersist(
  data: LayoutPersist,
  rightPanelClientHeight?: number,
  workspaceLayoutHeight?: number,
): LayoutPersist {
  const maxTop =
    typeof workspaceLayoutHeight === "number" && workspaceLayoutHeight > 0
      ? maxTopPaneHeightFromLayout(workspaceLayoutHeight)
      : maxTopPaneHeight();
  const topPaneH =
    data.topPaneH === TOP_PANE_MAXIMIZED
      ? TOP_PANE_MAXIMIZED
      : Math.min(maxTop, Math.max(0, data.topPaneH));
  const topPaneLastNonZero =
    data.topPaneLastNonZero > 0
      ? Math.min(maxTop, data.topPaneLastNonZero)
      : topPaneH > 0
        ? topPaneH
        : TOP_PANE_DEFAULT_H;

  let listToolbarPaneH = data.listToolbarPaneH;
  if (
    listToolbarPaneH !== null &&
    typeof rightPanelClientHeight === "number" &&
    rightPanelClientHeight > 0
  ) {
    listToolbarPaneH = Math.min(
      maxListToolbarHeight(rightPanelClientHeight),
      listToolbarPaneH,
    );
  }

  return {
    topPaneH,
    topPaneLastNonZero,
    listToolbarPaneH,
    listToolbarPaneLastNonZero: data.listToolbarPaneLastNonZero,
  };
}

type LayoutPersist = TestDesignLayoutPreference;

const LAYOUT_DEFAULTS: LayoutPersist = {
  topPaneH: TOP_PANE_DEFAULT_H,
  topPaneLastNonZero: TOP_PANE_DEFAULT_H,
  listToolbarPaneH: null,
  listToolbarPaneLastNonZero: 0,
};

function parseLayoutPersist(
  raw: Partial<LayoutPersist> | null | undefined,
): LayoutPersist | null {
  if (!raw || typeof raw !== "object") return null;
  const hasAny =
    typeof raw.topPaneH === "number" ||
    typeof raw.topPaneLastNonZero === "number" ||
    typeof raw.listToolbarPaneH === "number" ||
    typeof raw.listToolbarPaneLastNonZero === "number";
  if (!hasAny) return null;

  const topPaneH =
    typeof raw.topPaneH === "number" &&
    (raw.topPaneH === TOP_PANE_MAXIMIZED || raw.topPaneH >= 0)
      ? raw.topPaneH
      : LAYOUT_DEFAULTS.topPaneH;
  const topPaneLastNonZero =
    typeof raw.topPaneLastNonZero === "number" && raw.topPaneLastNonZero > 0
      ? raw.topPaneLastNonZero
      : topPaneH > 24
        ? topPaneH
        : LAYOUT_DEFAULTS.topPaneLastNonZero;
  const listToolbarPaneH =
    typeof raw.listToolbarPaneH === "number" && raw.listToolbarPaneH >= 0
      ? raw.listToolbarPaneH
      : null;
  const listToolbarPaneLastNonZero =
    typeof raw.listToolbarPaneLastNonZero === "number" &&
    raw.listToolbarPaneLastNonZero > 0
      ? raw.listToolbarPaneLastNonZero
      : LAYOUT_DEFAULTS.listToolbarPaneLastNonZero;

  return {
    topPaneH,
    topPaneLastNonZero,
    listToolbarPaneH,
    listToolbarPaneLastNonZero,
  };
}

function loadLayoutPersist(): LayoutPersist {
  if (typeof window === "undefined") return LAYOUT_DEFAULTS;
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return LAYOUT_DEFAULTS;
    return parseLayoutPersist(JSON.parse(raw) as Partial<LayoutPersist>) ?? LAYOUT_DEFAULTS;
  } catch {
    return LAYOUT_DEFAULTS;
  }
}

function saveLayoutPersist(data: LayoutPersist) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}
type CustomDir = {
  id: string;
  label: string;
  parentType: TestDesignType;
  parentId: string | null;
};

type CustomDirNode = CustomDir & { children: CustomDirNode[] };

function buildCustomDirTree(items: CustomDir[]): CustomDirNode[] {
  const map = new Map<string, CustomDirNode>();
  for (const it of items) map.set(it.id, { ...it, children: [] });
  const roots: CustomDirNode[] = [];
  for (const it of items) {
    const node = map.get(it.id)!;
    if (it.parentId && map.has(it.parentId)) map.get(it.parentId)!.children.push(node);
    else roots.push(node);
  }
  // 默认按 label 排序（目录没有 wbs），更直观
  const sortRec = (nodes: CustomDirNode[]) => {
    nodes.sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

function stripDirTag(title: string): string {
  const m = title.match(/^【[^】]+】\\s*(.*)$/);
  return m ? m[1] ?? "" : title;
}

function loadCategories(): CategoryItem[] {
  if (typeof window === "undefined") {
    return testDesignTypeOptions.map((o) => ({ key: o.value, label: o.label }));
  }
  try {
    const raw = localStorage.getItem(CATEGORY_STORAGE_KEY);
    if (!raw) {
      return testDesignTypeOptions.map((o) => ({ key: o.value, label: o.label }));
    }
    const j = JSON.parse(raw) as unknown;
    if (!Array.isArray(j)) throw new Error("bad");
    const base = new Map(testDesignTypeOptions.map((o) => [o.value, o.label]));
    const parsed: CategoryItem[] = [];
    for (const it of j) {
      if (!it || typeof it !== "object") continue;
      const rec = it as unknown as Record<string, unknown>;
      const key = rec.key as TestDesignType;
      const label = rec.label as string;
      const hidden = Boolean(rec.hidden);
      if (!base.has(key)) continue;
      parsed.push({
        key,
        label:
          typeof label === "string" && label.trim() ? label : base.get(key)!,
        hidden,
      });
      base.delete(key);
    }
    for (const [k, l] of base.entries()) parsed.push({ key: k as TestDesignType, label: l });
    return parsed;
  } catch {
    return testDesignTypeOptions.map((o) => ({ key: o.value, label: o.label }));
  }
}

function saveCategories(list: CategoryItem[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(list));
}

/** 与 SSR 首屏一致，避免用 localStorage 初始化导致 hydration mismatch */
function defaultCategoriesForHydration(): CategoryItem[] {
  return testDesignTypeOptions.map((o) => ({ key: o.value, label: o.label }));
}

function matchesText(h: string | null | undefined, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return String(h ?? "").toLowerCase().includes(s);
}

function filterTreeKeepAncestors<T extends { id: string; parentId: string | null }>(
  flat: T[],
  keep: (row: T) => boolean,
): T[] {
  const byId = new Map(flat.map((r) => [r.id, r]));
  const children = new Map<string | null, string[]>();
  for (const r of flat) {
    const k = r.parentId ?? null;
    const arr = children.get(k) ?? [];
    arr.push(r.id);
    children.set(k, arr);
  }
  const ok = new Set<string>();
  const dfs = (id: string): boolean => {
    const r = byId.get(id);
    if (!r) return false;
    let m = keep(r);
    for (const cid of children.get(id) ?? []) m = dfs(cid) || m;
    if (m) ok.add(id);
    return m;
  };
  for (const id of children.get(null) ?? []) dfs(id);
  return flat.filter((r) => ok.has(r.id));
}

function TreeRows({
  nodes,
  depth,
  requirementId,
  iterationCode,
  dirId,
  onAdded,
}: {
  nodes: Node[];
  depth: number;
  requirementId: string;
  iterationCode: string;
  dirId: string | null;
  onAdded: () => void;
}) {
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submitChild = async (parentId: string | null) => {
    setBusy(true);
    setErr(null);
    const parentType =
      parentId === null
        ? ("FUNCTIONAL" as TestDesignType)
        : nodes.find((x) => x.id === parentId)?.type;
    const r = await createTestDesignNode({
      requirementId,
      parentId,
      title: titleDraft,
      type: parentType ?? ("FUNCTIONAL" as TestDesignType),
      iterationCode,
      dirId,
    });
    setBusy(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    setAddingFor(null);
    setTitleDraft("");
    onAdded();
  };

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`确定删除「${label}」及其所有子节点？`)) return;
    setDelBusy(id);
    setErr(null);
    const r = await deleteTestDesignNode(id);
    setDelBusy(null);
    if (r.error) {
      setErr(r.error);
      return;
    }
    onAdded();
  };

  return (
    <div className="space-y-0">
      {err && (
        <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {err}
        </div>
      )}
      {nodes.map((n) => (
        <div key={n.id} className="select-none">
          <div
            className="group flex items-center gap-2 rounded-md py-1.5 pr-2 hover:bg-zinc-100"
            style={{ paddingLeft: depth * 14 + 8 }}
          >
            <span className="text-zinc-400">▸</span>
            <Link
              href={`/test-design/node/${n.id}`}
              className="flex-1 truncate text-sm font-medium text-zinc-900 underline-offset-2 hover:underline"
            >
              {stripDirTag(n.title) || n.title}
            </Link>
            <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 text-xs text-zinc-700">
              {testDesignTypeLabel[n.type]}
            </span>
            <button
              type="button"
              onClick={() => {
                setAddingFor(n.id);
                setTitleDraft("");
                setErr(null);
              }}
              className="shrink-0 rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700 opacity-0 transition hover:bg-zinc-50 group-hover:opacity-100"
            >
              添加子节点
            </button>
            <button
              type="button"
              disabled={delBusy === n.id}
              onClick={() => remove(n.id, n.title)}
              className="shrink-0 rounded border border-red-200 bg-white px-2 py-0.5 text-xs text-red-700 opacity-0 transition hover:bg-red-50 group-hover:opacity-100 disabled:opacity-50"
            >
              {delBusy === n.id ? "删除中" : "删除"}
            </button>
          </div>

          {addingFor === n.id && (
            <div
              className="mb-2 mt-1 flex flex-wrap items-end gap-2 border-l-2 border-zinc-300 pl-3"
              style={{ marginLeft: depth * 14 + 24 }}
            >
              <input
                className="min-w-[160px] rounded-md border border-zinc-300 px-2 py-1 text-sm"
                placeholder="子节点标题"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => submitChild(n.id)}
                className="rounded-md bg-zinc-900 px-3 py-1 text-xs text-white disabled:opacity-50"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => setAddingFor(null)}
                className="text-xs text-zinc-500"
              >
                取消
              </button>
            </div>
          )}

          {n.children.length > 0 && (
            <TreeRows
              nodes={n.children}
              depth={depth + 1}
              requirementId={requirementId}
              iterationCode={iterationCode}
              dirId={dirId}
              onAdded={onAdded}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export function TestDesignTreeClient({
  iterations,
  initialProductId = "",
  initialIterationCode = "",
  initialRequirementId = "",
  initialCategory = "",
  initialDirId = "",
  onImmersiveLayoutChange,
}: {
  iterations: { code: string; label: string; productId?: string | null }[];
  /** 由服务端 page 解析 query，与详情「返回测试设计树」上的产品一致 */
  initialProductId?: string;
  /** 由服务端 page 解析 query，避免首屏 iterationCode 为空时误请求空列表 */
  initialIterationCode?: string;
  initialRequirementId?: string;
  /** 详情链回时恢复侧栏类别（如 PERFORMANCE） */
  initialCategory?: TestDesignType | "";
  /** 详情链回时恢复侧栏自定义目录 */
  initialDirId?: string;
  /** 需求目录收至顶时隐藏页眉，设计区铺满 */
  onImmersiveLayoutChange?: (immersive: boolean) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [products, setProducts] = useState<ProductOption[]>([]);
  const trimmedInitialProductId = initialProductId.trim();
  const hasUrlProductId = !!trimmedInitialProductId;
  const [productId, setProductId] = useState(() => trimmedInitialProductId);
  const productPrefHydratedRef = useRef(false);
  const hasUrlIterationCode = !!initialIterationCode.trim();
  const urlPendingRequirementIdRef = useRef<string | null>(
    initialRequirementId.trim() || null,
  );
  const urlPendingDirIdRef = useRef<string | null>(
    initialDirId.trim() || null,
  );
  const deeplinkScrollReqIdRef = useRef<string | null>(null);
  /** 需求目录滚动容器：链回 / URL 带 requirementId 时将选中项滚入可视区域 */
  const reqTreeScrollRef = useRef<HTMLDivElement | null>(null);
  const workspaceLayoutRef = useRef<HTMLDivElement | null>(null);
  const lastSyncedLocationSearchRef = useRef<string | undefined>(undefined);
  const [iterationCode, setIterationCode] = useState<string>(() => {
    const ic = initialIterationCode.trim();
    if (!ic) return "";
    return iterations.some((it) => it.code === ic) ? ic : "";
  });
  const iterationPrefHydratedRef = useRef(false);
  const visibleIterations = useMemo(
    () =>
      productId
        ? iterations.filter((it) => (it.productId ?? "") === productId || it.code === "")
        : iterations,
    [iterations, productId],
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
    if (hasUrlProductId) {
      productPrefHydratedRef.current = true;
      return;
    }
    if (typeof window !== "undefined") {
      const u = new URLSearchParams(window.location.search);
      if (u.get("productId")?.trim()) {
        productPrefHydratedRef.current = true;
        return;
      }
    }
    let cancelled = false;
    void (async () => {
      const pref = await getGlobalIterationProductPreference();
      if (cancelled) return;
      const candidate = (pref.productId ?? "").trim();
      if (candidate) setProductId(candidate);
      productPrefHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [hasUrlProductId]);

  useEffect(() => {
    if (!trimmedInitialProductId) return;
    setProductId((prev) =>
      prev === trimmedInitialProductId ? prev : trimmedInitialProductId,
    );
  }, [trimmedInitialProductId]);

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
    if (!visibleIterations.some((it) => it.code === iterationCode)) {
      setIterationCode("");
    }
  }, [visibleIterations, iterationCode]);
  const persistedLayoutRef = useRef<LayoutPersist>(LAYOUT_DEFAULTS);
  const [topPaneH, setTopPaneH] = useState(LAYOUT_DEFAULTS.topPaneH);
  const [reqFlat, setReqFlat] = useState<RequirementTreeFlat[]>([]);
  const [selectedReqId, setSelectedReqId] = useState<string>("");
  const [flat, setFlat] = useState<TestDesignFlat[]>([]);
  const [loading, setLoading] = useState(false);
  const [rootErr, setRootErr] = useState<string | null>(null);
  const [rootTitle, setRootTitle] = useState("");
  const [rootBusy, setRootBusy] = useState(false);
  const [category, setCategory] = useState<TestDesignType>(() => {
    const fromUrl = parseDesignTypeParam(initialCategory);
    return fromUrl ?? "FUNCTIONAL";
  });
  const [categoryEditOpen, setCategoryEditOpen] = useState(false);
  const [categories, setCategories] = useState<CategoryItem[]>(() =>
    defaultCategoriesForHydration(),
  );
  const [customDirs, setCustomDirs] = useState<CustomDir[]>([]);
  const [selectedCustomDirId, setSelectedCustomDirId] = useState<string | null>(null);
  const [dirExpandedById, setDirExpandedById] = useState<Record<string, boolean>>({});
  const dragDirIdRef = useRef<string | null>(null);
  const [reqSearch, setReqSearch] = useState("");
  const [designSearch, setDesignSearch] = useState("");
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditType, setBulkEditType] = useState<TestDesignType | "">("");
  const [bulkEditDirId, setBulkEditDirId] = useState<string>(""); // "" 不修改；"__clear__" 清空；否则 dirId
  const [countsByType, setCountsByType] = useState<Record<TestDesignType, number>>({
    FUNCTIONAL: 0,
    PERFORMANCE: 0,
    SECURITY: 0,
    COMPATIBILITY: 0,
    USABILITY: 0,
    RELIABILITY: 0,
    OTHER: 0,
  });
  const [otherFlatAll, setOtherFlatAll] = useState<TestDesignFlat[]>([]);
  const [dirCountsById, setDirCountsById] = useState<Record<string, number>>({});
  const [reqDesignCounts, setReqDesignCounts] = useState<Record<string, number>>(
    {},
  );
  const [expandedReq, setExpandedReq] = useState<Record<string, boolean>>({});
  const reqFlatRef = useRef(reqFlat);
  reqFlatRef.current = reqFlat;
  const iterationCodeRef = useRef(iterationCode);
  iterationCodeRef.current = iterationCode;
  /** 当前 iterationCode 是否已从 DB 拉取并合并过展开偏好 */
  const expandDbLoadedForIcRef = useRef<string | null>(null);
  /** 避免首屏尚未合并 DB 偏好就写回空数据 */
  const reqTreeExpandSaveReadyRef = useRef(false);
  const expandedReqRef = useRef(expandedReq);
  expandedReqRef.current = expandedReq;
  /** 设计数据变更触发计数刷新（否则 iterationCode/reqFlat 未变时不会重算） */
  const [designRevision, setDesignRevision] = useState(0);

  const [selectedDesignIds, setSelectedDesignIds] = useState<string[]>([]);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const selectAllFullVisibleRef = useRef<HTMLInputElement | null>(null);
  const [batchWorking, setBatchWorking] = useState(false);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveTargetReqId, setMoveTargetReqId] = useState<string>("");
  const [moveTargetIterationCode, setMoveTargetIterationCode] = useState<string>("");
  const [moveReqOptions, setMoveReqOptions] = useState<RequirementTreeFlat[]>([]);
  const [moveAllModalOpen, setMoveAllModalOpen] = useState(false);
  const [moveAllSourceReqId, setMoveAllSourceReqId] = useState<string>("");
  const [newCustomDirOpen, setNewCustomDirOpen] = useState(false);
  const [newCustomDirName, setNewCustomDirName] = useState("");
  const newCustomDirInputRef = useRef<HTMLInputElement | null>(null);
  const [restoreHiddenOpen, setRestoreHiddenOpen] = useState(false);
  const [hideBlockedDialog, setHideBlockedDialog] = useState<{
    title: string;
    detail: string;
  } | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  const [adv, setAdv] = useState({
    titleContains: "",
    createdBy: "",
    updatedBy: "",
    createdFrom: "",
    createdTo: "",
    updatedFrom: "",
    updatedTo: "",
    /** 关联用例列筛选：全部 / 已关联 / 未关联 */
    linkedCases: "all" as "all" | "linked" | "unlinked",
  });

  const topPaneLastNonZeroRef = useRef<number>(LAYOUT_DEFAULTS.topPaneLastNonZero);
  const listToolbarPaneRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLElement | null>(null);
  const listToolbarPaneFullHRef = useRef(0);
  const listToolbarPaneLastNonZeroRef = useRef<number>(
    LAYOUT_DEFAULTS.listToolbarPaneLastNonZero,
  );
  /** 右侧列表上方工具区可视高度；null 表示随内容自然撑开 */
  const [listToolbarPaneH, setListToolbarPaneH] = useState<number | null>(
    LAYOUT_DEFAULTS.listToolbarPaneH,
  );
  const skipLayoutPersistRef = useRef(true);
  const layoutPrefHydratedRef = useRef(false);
  const [layoutHydrated, setLayoutHydrated] = useState(false);

  const applyLayoutPersist = useCallback((data: LayoutPersist) => {
    skipLayoutPersistRef.current = true;
    const clamped = clampLayoutPersist(
      data,
      rightPanelRef.current?.clientHeight,
      workspaceLayoutRef.current?.clientHeight,
    );
    topPaneLastNonZeroRef.current = clamped.topPaneLastNonZero;
    listToolbarPaneLastNonZeroRef.current = clamped.listToolbarPaneLastNonZero;
    setTopPaneH(clamped.topPaneH);
    setListToolbarPaneH(clamped.listToolbarPaneH);
    saveLayoutPersist(clamped);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const local = loadLayoutPersist();
      const pref = await getGlobalTestDesignLayoutPreference();
      if (cancelled) return;
      const layout = pref.layout ?? local;
      persistedLayoutRef.current = layout;
      applyLayoutPersist(layout);
      if (
        !pref.layout &&
        typeof window !== "undefined" &&
        localStorage.getItem(LAYOUT_STORAGE_KEY) !== null
      ) {
        void saveGlobalTestDesignLayoutPreference(layout);
      }
      layoutPrefHydratedRef.current = true;
      setLayoutHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLayoutPersist]);

  useEffect(() => {
    const clampToViewport = () => {
      const layoutH = workspaceLayoutRef.current?.clientHeight ?? 0;
      const maxTop =
        layoutH > 0 ? maxTopPaneHeightFromLayout(layoutH) : maxTopPaneHeight();
      setTopPaneH((cur) => {
        if (cur <= 0) return cur;
        return Math.min(cur, maxTop);
      });
      const parentH = rightPanelRef.current?.clientHeight;
      if (!parentH) return;
      setListToolbarPaneH((cur) => {
        if (cur === null) return null;
        const max = maxListToolbarHeight(parentH);
        return Math.min(cur, max);
      });
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [selectedReqId, advOpen]);

  const [catPaneW, setCatPaneW] = useState(140);
  const {
    config: designColConfig,
    visibleOrdered: designVisibleOrdered,
    setVisible: setDesignColVisible,
    moveKey: moveDesignCol,
    setWidth: setDesignColWidth,
    widthFor: designWidthFor,
    resetDefaults: resetDesignCols,
  } = useTestDesignListColumns();
  const [designGearOpen, setDesignGearOpen] = useState(false);
  const skipFirstCategoriesPersist = useRef(true);

  useEffect(() => {
    setCategories(loadCategories());
  }, []);

  const startResizeCatPane = useCallback(
    (startX: number) => {
      const startW = catPaneW;
      const onMove = (e: MouseEvent) => {
        const dx = e.clientX - startX;
        const next = Math.max(120, Math.min(520, Math.round(startW + dx)));
        setCatPaneW(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [catPaneW],
  );

  const startResizeDesignCol = useCallback(
    (e: React.MouseEvent, key: TestDesignColumnKey) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = designWidthFor(key);
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        setDesignColWidth(key, startW + dx);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [designWidthFor, setDesignColWidth],
  );

  const designTableMinW = useMemo(() => {
    const sum = designVisibleOrdered.reduce(
      (a, k) => a + designWidthFor(k),
      0,
    );
    return sum + 80 + 24;
  }, [designVisibleOrdered, designWidthFor]);

  useEffect(() => {
    if (skipFirstCategoriesPersist.current) {
      skipFirstCategoriesPersist.current = false;
      return;
    }
    saveCategories(categories);
  }, [categories]);

  useEffect(() => {
    (async () => {
      const r = await listTestDesignDirs({ iterationCode });
      if (r.error) {
        setCustomDirs([]);
        return;
      }
      const rows = r.rows ?? [];
      setCustomDirs(
        rows.map((x) => ({
          id: x.id,
          label: x.name,
          parentType: x.type,
          parentId: x.parentId,
        })),
      );
      // 默认展开根目录
      setDirExpandedById((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          if (!row.parentId && next[row.id] === undefined) next[row.id] = true;
        }
        return next;
      });
    })();
  }, [iterationCode]);

  useEffect(() => {
    const pending = urlPendingDirIdRef.current;
    if (!pending) return;
    const dir = customDirs.find((d) => d.id === pending);
    if (!dir) return;
    setCategory(dir.parentType);
    setSelectedCustomDirId(pending);
    setDirExpandedById((prev) => ({
      ...prev,
      ...expandCustomDirAncestors(pending, customDirs),
    }));
    urlPendingDirIdRef.current = null;
  }, [customDirs]);

  const visibleCategories = useMemo(
    () => categories.filter((c) => !c.hidden),
    [categories],
  );
  const visibleCustomDirs = useMemo(() => {
    return customDirs;
  }, [customDirs]);
  const visibleCustomDirsByType = useMemo(() => {
    const m = new Map<TestDesignType, CustomDir[]>();
    for (const d of visibleCustomDirs) {
      const arr = m.get(d.parentType) ?? [];
      arr.push(d);
      m.set(d.parentType, arr);
    }
    return m;
  }, [visibleCustomDirs]);
  const hiddenCategoriesForRestore = useMemo(
    () => categories.filter((c) => c.hidden),
    [categories],
  );
  const hiddenCustomDirsForRestore = useMemo<CustomDir[]>(() => [], []);
  const activeCustomDir = useMemo(() => {
    if (!selectedCustomDirId) return null;
    return visibleCustomDirs.find((d) => d.id === selectedCustomDirId) ?? null;
  }, [selectedCustomDirId, visibleCustomDirs]);

  useEffect(() => {
    if (!visibleCategories.some((c) => c.key === category)) {
      setCategory(visibleCategories[0]?.key ?? ("FUNCTIONAL" as TestDesignType));
    }
  }, [category, visibleCategories]);

  useEffect(() => {
    // 切换类别时，若当前目录不属于该类别则清空
    if (activeCustomDir && activeCustomDir.parentType !== category) {
      setSelectedCustomDirId(null);
    }
  }, [activeCustomDir, category]);

  useEffect(() => {
    if (!newCustomDirOpen) return;
    const t = window.setTimeout(() => newCustomDirInputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [newCustomDirOpen]);

  useEffect(() => {
    if (!newCustomDirOpen && !restoreHiddenOpen && !hideBlockedDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setNewCustomDirOpen(false);
      setRestoreHiddenOpen(false);
      setHideBlockedDialog(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hideBlockedDialog, newCustomDirOpen, restoreHiddenOpen]);

  const submitNewCustomDir = () => {
    const name = newCustomDirName.trim();
    if (!name) return;
    const ic = iterationCode.trim();
    if (!ic) {
      window.alert("请先选择具体迭代（baseline 不支持维护子目录）。");
      return;
    }
    (async () => {
      const r = await createTestDesignDir({
        iterationCode: ic,
        type: category,
        parentId: null,
        name,
      });
      if (r.error) {
        window.alert(r.error);
        return;
      }
      const r2 = await listTestDesignDirs({ iterationCode });
      setCustomDirs(
        (r2.rows ?? []).map((x) => ({
          id: x.id,
          label: x.name,
          parentType: x.type,
          parentId: x.parentId,
        })),
      );
      setNewCustomDirOpen(false);
      setNewCustomDirName("");
    })();
  };

  const openRestoreHiddenModal = () => {
    if (
      hiddenCategoriesForRestore.length === 0 &&
      hiddenCustomDirsForRestore.length === 0
    ) {
      window.alert(
        "没有可恢复的隐藏目录（系统分类与自定义目录均已显示）。",
      );
      return;
    }
    setRestoreHiddenOpen(true);
  };

  const restoreHiddenCategory = (key: TestDesignType) => {
    setCategories((prev) =>
      prev.map((x) => (x.key === key ? { ...x, hidden: false } : x)),
    );
    setRestoreHiddenOpen(false);
  };

  const restoreHiddenCustomDir = (id: string) => {
    setRestoreHiddenOpen(false);
  };

  const confirmHideCategory = useCallback(
    async (key: TestDesignType, label: string) => {
      const r = await countTestDesignsForCategoryHide({
        type: key,
        iterationCode,
      });
      if ("error" in r) {
        setHideBlockedDialog({
          title: "不可删除",
          detail: `校验时出错，暂时不能从侧栏删除「${label}」类别。\n\n原因：${r.error}`,
        });
        return;
      }
      if (r.count > 0) {
        const scope = iterationCode.trim()
          ? "当前迭代筛选下"
          : "全部迭代范围内";
        setHideBlockedDialog({
          title: "不可删除",
          detail: `「${label}」类别下仍有关联的测试设计数据，需先处理后才能从侧栏删除该类别。\n\n原因：${scope}仍有 ${r.count} 条该类型测试设计。请迁移、删除或调整类型后再试。`,
        });
        return;
      }
      if (
        !window.confirm(
          `确定从侧栏删除类别「${label}」？仅移除侧栏入口，测试设计数据仍保留；可在「恢复隐藏」中找回。`,
        )
      ) {
        return;
      }
      setCategories((prev) =>
        prev.map((x) => (x.key === key ? { ...x, hidden: true } : x)),
      );
    },
    [iterationCode],
  );

  const confirmHideCustomDir = useCallback(
    async (id: string, label: string) => {
      if (!window.confirm(`确定删除自定义目录「${label}」？删除后不可恢复。`)) return;
      const r = await deleteTestDesignDir(id);
      if (r.error) {
        setHideBlockedDialog({ title: "不可删除", detail: r.error });
        return;
      }
      const r2 = await listTestDesignDirs({ iterationCode });
      setCustomDirs(
        (r2.rows ?? []).map((x) => ({
          id: x.id,
          label: x.name,
          parentType: x.type,
          parentId: x.parentId,
        })),
      );
    },
    [iterationCode],
  );

  const reload = useCallback(async () => {
    if (!selectedReqId) {
      setFlat([]);
      return;
    }
    setLoading(true);
    const dirId =
      activeCustomDir && activeCustomDir.parentType === category
        ? activeCustomDir.id
        : null;
    const scopeReqIds = collectReqSubtreeIds(selectedReqId, reqFlat);
    const data = await getTestDesignFlatForRequirements({
      requirementIds: scopeReqIds,
      iterationCode: iterationCode === "" ? "" : iterationCode,
      type: category,
      dirId,
    });
    setFlat(data);
    setLoading(false);
  }, [activeCustomDir, category, iterationCode, selectedReqId, reqFlat]);

  const startResizeTopPane = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const sy = e.clientY;
    const layoutH = workspaceLayoutRef.current?.clientHeight ?? 0;
    const fullMax =
      layoutH > 0 ? maxTopPaneHeightFromLayout(layoutH) : maxTopPaneHeight();
    const h0 =
      topPaneH === TOP_PANE_MAXIMIZED
        ? fullMax
        : topPaneH <= 0
          ? 0
          : topPaneH;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - sy;
      const next = Math.min(fullMax, Math.max(0, h0 + dy));
      if (next <= 0) {
        setTopPaneH(0);
        return;
      }
      if (next >= fullMax - TOP_PANE_SNAP_THRESHOLD) {
        if (next < fullMax) topPaneLastNonZeroRef.current = next;
        setTopPaneH(TOP_PANE_MAXIMIZED);
        return;
      }
      topPaneLastNonZeroRef.current = next;
      setTopPaneH(next);
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
  }, [topPaneH]);

  const topPaneCollapsed = topPaneH === 0;
  const topPaneMaximized = topPaneH === TOP_PANE_MAXIMIZED;
  const restoreTopPane = useCallback(() => {
    setTopPaneH((cur) => {
      if (cur === TOP_PANE_MAXIMIZED) {
        return Math.max(96, topPaneLastNonZeroRef.current || TOP_PANE_DEFAULT_H);
      }
      if (cur > 0) {
        topPaneLastNonZeroRef.current = cur;
        return 0;
      }
      return Math.max(96, topPaneLastNonZeroRef.current || TOP_PANE_DEFAULT_H);
    });
  }, []);

  useEffect(() => {
    if (!layoutHydrated) return;
    onImmersiveLayoutChange?.(topPaneCollapsed || topPaneMaximized);
  }, [layoutHydrated, topPaneCollapsed, topPaneMaximized, onImmersiveLayoutChange]);

  useLayoutEffect(() => {
    const el = listToolbarPaneRef.current;
    if (!el) return;
    if (listToolbarPaneH !== null && listToolbarPaneH <= 0) return;
    const natural = el.scrollHeight;
    if (natural <= 0) return;
    const prevFull = listToolbarPaneFullHRef.current;
    listToolbarPaneFullHRef.current = natural;
    if (listToolbarPaneLastNonZeroRef.current <= 0) {
      listToolbarPaneLastNonZeroRef.current = natural;
    }
    setListToolbarPaneH((cur) => {
      if (cur === null) return null;
      if (cur <= 0) return cur;
      if (prevFull > 0 && cur >= prevFull - 1) return natural;
      return Math.min(cur, natural);
    });
  }, [advOpen, rootErr, selectedReqId, category, designSearch, listToolbarPaneH]);

  useEffect(() => {
    if (!layoutPrefHydratedRef.current) return;
    if (skipLayoutPersistRef.current) {
      skipLayoutPersistRef.current = false;
      return;
    }
    const data: LayoutPersist = clampLayoutPersist(
      {
        topPaneH,
        topPaneLastNonZero: topPaneLastNonZeroRef.current,
        listToolbarPaneH,
        listToolbarPaneLastNonZero: listToolbarPaneLastNonZeroRef.current,
      },
      rightPanelRef.current?.clientHeight,
      workspaceLayoutRef.current?.clientHeight,
    );
    const t = window.setTimeout(() => {
      saveLayoutPersist(data);
      void saveGlobalTestDesignLayoutPreference(data);
    }, 350);
    return () => window.clearTimeout(t);
  }, [topPaneH, listToolbarPaneH]);

  const startResizeListToolbarPane = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture?.(e.pointerId);
      const sy = e.clientY;
      const fullH = listToolbarPaneFullHRef.current;
      const h0 = listToolbarPaneH ?? fullH;
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - sy;
        const parentH = rightPanelRef.current?.clientHeight ?? 0;
        const maxToolbarH =
          parentH > 0
            ? Math.min(fullH, maxListToolbarHeight(parentH))
            : fullH;
        const next = Math.min(maxToolbarH, Math.max(0, h0 + dy));
        if (next > 0) listToolbarPaneLastNonZeroRef.current = next;
        setListToolbarPaneH(next);
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
    [listToolbarPaneH],
  );

  const listToolbarPaneCollapsed =
    listToolbarPaneH !== null && listToolbarPaneH <= 0;
  const restoreListToolbarPane = useCallback(() => {
    setListToolbarPaneH((cur) => {
      const full = listToolbarPaneFullHRef.current;
      const parentH = rightPanelRef.current?.clientHeight ?? 0;
      const maxToolbarH =
        parentH > 0
          ? Math.min(full, maxListToolbarHeight(parentH))
          : full;
      const h = cur ?? maxToolbarH;
      if (h > 0) {
        listToolbarPaneLastNonZeroRef.current = h;
        return 0;
      }
      return Math.max(
        48,
        Math.min(
          listToolbarPaneLastNonZeroRef.current || maxToolbarH || 120,
          maxToolbarH || full || 120,
        ),
      );
    });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!selectedReqId) return;
    try {
      sessionStorage.setItem(
        TEST_DESIGN_TREE_CONTEXT_STORAGE,
        JSON.stringify({
          productId: productId.trim(),
          iterationCode: iterationCode.trim(),
          requirementId: selectedReqId,
          type: category,
          dirId: selectedCustomDirId,
        }),
      );
    } catch {
      // ignore
    }
  }, [
    productId,
    iterationCode,
    selectedReqId,
    category,
    selectedCustomDirId,
  ]);

  /** 从地址栏同步产品/迭代/需求（详情链回）；首帧用 location 避免 useSearchParams 滞后。qs 未变则不再覆盖，避免下拉改迭代后被 URL 打回 */
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const qs = window.location.search;
    if (lastSyncedLocationSearchRef.current === qs) return;

    const sp = new URLSearchParams(qs);
    let ic = sp.get("iterationCode")?.trim() ?? "";
    let rq = sp.get("requirementId")?.trim() ?? "";
    let pid = sp.get("productId")?.trim() ?? "";
    if (!ic) ic = searchParams.get("iterationCode")?.trim() ?? "";
    if (!rq) rq = searchParams.get("requirementId")?.trim() ?? "";
    if (!pid) pid = searchParams.get("productId")?.trim() ?? "";

    const pidValid =
      !!pid && iterations.some((it) => (it.productId ?? "") === pid);

    if (pidValid && pid !== productId) {
      setProductId(pid);
      return;
    }

    const typeRaw = sp.get("type")?.trim() ?? searchParams.get("type")?.trim() ?? "";
    let parsedType = parseDesignTypeParam(typeRaw);
    if (parsedType) {
      setCategory(parsedType);
    } else {
      try {
        const raw = sessionStorage.getItem(TEST_DESIGN_TREE_CONTEXT_STORAGE);
        if (raw) {
          const j = JSON.parse(raw) as {
            type?: string;
            dirId?: string | null;
            requirementId?: string;
          };
          const matchReq = !rq || j.requirementId === rq;
          if (matchReq) {
            const storedType = parseDesignTypeParam(j.type ?? "");
            if (storedType) {
              parsedType = storedType;
              setCategory(storedType);
            }
            const storedDir = (j.dirId ?? "").trim();
            if (storedDir) urlPendingDirIdRef.current = storedDir;
          }
        }
      } catch {
        // ignore
      }
    }

    const dirRaw = sp.get("dirId")?.trim() ?? searchParams.get("dirId")?.trim() ?? "";
    if (dirRaw) {
      urlPendingDirIdRef.current = dirRaw;
    } else if (parsedType && !urlPendingDirIdRef.current) {
      urlPendingDirIdRef.current = null;
      setSelectedCustomDirId(null);
    }

    if (!ic && !rq && !parsedType && !dirRaw) {
      lastSyncedLocationSearchRef.current = qs;
      return;
    }
    if (rq) urlPendingRequirementIdRef.current = rq;

    if (ic) {
      let ok = visibleIterations.some((it) => it.code === ic);
      if (!ok) {
        const row = iterations.find((it) => it.code === ic && it.code !== "");
        if (row?.productId && row.productId !== productId) {
          setProductId(row.productId);
          return;
        }
        if (!row) {
          lastSyncedLocationSearchRef.current = qs;
          return;
        }
        ok = visibleIterations.some((it) => it.code === ic);
      }
      if (!ok && visibleIterations.length === 0) return;
      if (ok) setIterationCode(ic);
    }
    lastSyncedLocationSearchRef.current = qs;
  }, [searchParams, visibleIterations, iterations, productId]);

  useEffect(() => {
    if (hasUrlIterationCode) {
      iterationPrefHydratedRef.current = true;
      return;
    }
    let cancelled = false;
    void (async () => {
      const pref = await getGlobalTestDesignIterationPreference();
      if (cancelled) return;
      const candidate = (pref.iterationCode ?? "").trim();
      if (!candidate) {
        setIterationCode("");
      } else if (visibleIterations.some((it) => it.code === candidate)) {
        setIterationCode((prev) => (prev === candidate ? prev : candidate));
      }
      iterationPrefHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [hasUrlIterationCode, visibleIterations]);

  useEffect(() => {
    if (!iterationPrefHydratedRef.current) return;
    const t = window.setTimeout(() => {
      void saveGlobalTestDesignIterationPreference({ iterationCode });
    }, 400);
    return () => clearTimeout(t);
  }, [iterationCode]);

  useEffect(() => {
    expandDbLoadedForIcRef.current = null;
    reqTreeExpandSaveReadyRef.current = false;
  }, [iterationCode]);

  useEffect(() => {
    setReqFlat([]);
  }, [iterationCode]);

  useEffect(() => {
    const ic = iterationCode.trim();
    const rows = reqFlat;
    if (rows.length === 0) return;

    if (expandDbLoadedForIcRef.current === ic) {
      setExpandedReq((prev) =>
        expandDefaultsForRoots(filterReqExpandToKnownIds(prev, rows), rows),
      );
      return;
    }

    let cancelled = false;
    void (async () => {
      const pref = await getTestDesignReqTreeExpandPreference();
      if (cancelled) return;
      if (iterationCodeRef.current.trim() !== ic) return;
      const rowsNow = reqFlatRef.current;
      if (rowsNow.length === 0) return;
      const serverMap = filterReqExpandToKnownIds(
        pref.byIteration[ic] ?? {},
        rowsNow,
      );
      setExpandedReq((prev) => {
        if (iterationCodeRef.current.trim() !== ic) return prev;
        const rows2 = reqFlatRef.current;
        const prevClean = filterReqExpandToKnownIds(prev, rows2);
        /** DB 中明确存的 false 必须赢过内存里的默认「根展开」 */
        return expandDefaultsForRoots(
          { ...prevClean, ...serverMap },
          rows2,
        );
      });
      expandDbLoadedForIcRef.current = ic;
      reqTreeExpandSaveReadyRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [iterationCode, reqFlat]);

  useEffect(() => {
    if (!reqTreeExpandSaveReadyRef.current) return;
    const ic = iterationCode.trim();
    const rows = reqFlatRef.current;
    if (rows.length === 0) return;
    const t = window.setTimeout(() => {
      if (iterationCodeRef.current.trim() !== ic) return;
      void saveTestDesignReqTreeExpandPreference({
        iterationCode: ic,
        expandedByReqId: filterReqExpandToKnownIds(
          expandedReqRef.current,
          reqFlatRef.current,
        ),
      });
    }, 500);
    return () => clearTimeout(t);
  }, [expandedReq, iterationCode, reqFlat]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await listRequirementsForDesignTree(iterationCode);
      if (cancelled) return;
      setReqFlat(rows);
      const pending = urlPendingRequirementIdRef.current;
      if (pending && rows.some((r) => r.id === pending)) {
        setSelectedReqId(pending);
        urlPendingRequirementIdRef.current = null;
        deeplinkScrollReqIdRef.current = pending;
        setExpandedReq((prev) => ({
          ...prev,
          ...expandRequirementAncestors(pending, rows),
        }));
      } else if (!pending) {
        setSelectedReqId(rows[0]?.id ?? "");
      } else {
        setSelectedReqId(rows[0]?.id ?? "");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [iterationCode]);

  const scrollRequirementRowIntoTreeView = useCallback((id: string) => {
    const el = document.querySelector(
      `[data-td-req-row="${CSS.escape(id)}"]`,
    ) as HTMLElement | null;
    if (!el) return false;
    const container = reqTreeScrollRef.current;
    if (container?.contains(el)) {
      const cRect = container.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      const delta =
        eRect.top - cRect.top - cRect.height / 2 + eRect.height / 2;
      container.scrollTop += delta;
      return true;
    }
    el.scrollIntoView({ block: "center", behavior: "auto" });
    return true;
  }, []);

  useEffect(() => {
    const target = deeplinkScrollReqIdRef.current;
    if (!target || target !== selectedReqId || reqFlat.length === 0) return;

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 20;

    const tick = () => {
      if (cancelled) return;
      if (scrollRequirementRowIntoTreeView(target)) {
        deeplinkScrollReqIdRef.current = null;
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        deeplinkScrollReqIdRef.current = null;
        return;
      }
      window.requestAnimationFrame(tick);
    };

    window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
  }, [
    selectedReqId,
    reqFlat,
    expandedReq,
    scrollRequirementRowIntoTreeView,
  ]);

  useEffect(() => {
    // 初始化需求树展开：默认展开根
    setExpandedReq((prev) => {
      const next = { ...prev };
      for (const r of reqFlat) {
        if (!r.parentId && next[r.id] === undefined) next[r.id] = true;
      }
      return next;
    });
  }, [reqFlat]);

  useEffect(() => {
    (async () => {
      const code = iterationCode === "" ? "" : iterationCode;
      if (code === "" || reqFlat.length === 0) {
        setReqDesignCounts({});
        return;
      }
      const m = await countTestDesignByRequirement({
        iterationCode: code,
        requirementIds: reqFlat.map((r) => r.id),
      });
      // 父需求展示其子树的设计数：将直接计数向上汇总到父节点
      const children = new Map<string, string[]>();
      for (const r of reqFlat) {
        if (!r.parentId) continue;
        const arr = children.get(r.parentId) ?? [];
        arr.push(r.id);
        children.set(r.parentId, arr);
      }
      const memo = new Map<string, number>();
      const dfs = (id: string): number => {
        const hit = memo.get(id);
        if (hit !== undefined) return hit;
        let t = typeof m[id] === "number" ? m[id] : 0;
        for (const cid of children.get(id) ?? []) t += dfs(cid);
        memo.set(id, t);
        return t;
      };
      const out: Record<string, number> = {};
      for (const r of reqFlat) out[r.id] = dfs(r.id);
      setReqDesignCounts(out);
    })();
  }, [iterationCode, reqFlat, designRevision]);

  useEffect(() => {
    (async () => {
      if (!selectedReqId) {
        setCountsByType({
          FUNCTIONAL: 0,
          PERFORMANCE: 0,
          SECURITY: 0,
          COMPATIBILITY: 0,
          USABILITY: 0,
          RELIABILITY: 0,
          OTHER: 0,
        });
        setOtherFlatAll([]);
        setDirCountsById({});
        return;
      }
      const code = iterationCode === "" ? "" : iterationCode;
      const scopeReqIds = collectReqSubtreeIds(selectedReqId, reqFlat);
      const counts = await countTestDesignByTypeForRequirements({
        requirementIds: scopeReqIds,
        iterationCode: code,
      });
      setCountsByType(counts);
      if (code === "") {
        setOtherFlatAll([]);
        setDirCountsById({});
        return;
      }
      const other = await getTestDesignFlatForRequirements({
        requirementIds: scopeReqIds,
        iterationCode: code,
        type: "OTHER",
      });
      setOtherFlatAll(other);

      const dirCountRes = await countTestDesignByDirSubtreeForRequirements({
        requirementIds: scopeReqIds,
        iterationCode: code,
      });
      if (dirCountRes.error || !dirCountRes.counts) {
        setDirCountsById({});
      } else {
        setDirCountsById(dirCountRes.counts);
      }
    })();
  }, [customDirs, iterationCode, selectedReqId, reqFlat, designRevision]);

  const filteredReqFlat = useMemo(() => {
    if (!reqSearch.trim()) return reqFlat;
    return filterTreeKeepAncestors(reqFlat, (r) => matchesText(r.title, reqSearch));
  }, [reqFlat, reqSearch]);
  const reqTree = useMemo(() => {
    const tree = buildTree(filteredReqFlat);
    const sortRec = (nodes: ReqNode[]): ReqNode[] => {
      const out = [...nodes]
        .map((n) => ({ ...n, children: sortRec(n.children) }))
        .sort((a, b) => compareWbsId(a.wbsId, b.wbsId) || a.title.localeCompare(b.title, "zh-CN"));
      return out;
    };
    return sortRec(tree);
  }, [filteredReqFlat]);

  const filteredDesignFlat = useMemo(() => {
    if (!designSearch.trim()) return flat;
    return filterTreeKeepAncestors(flat, (r) => matchesText(r.title, designSearch));
  }, [designSearch, flat]);
  const filteredByCustomDir = useMemo(() => {
    if (!activeCustomDir || activeCustomDir.parentType !== category) return filteredDesignFlat;
    return filteredDesignFlat.filter((r) => r.dirId === activeCustomDir.id);
  }, [activeCustomDir, category, filteredDesignFlat]);

  const listRows = useMemo(() => {
    const q = adv.titleContains.trim().toLowerCase();
    const toMs = (d: string, end: boolean) => {
      if (!d) return null;
      const dt = new Date(end ? `${d}T23:59:59.999` : `${d}T00:00:00`);
      const t = dt.getTime();
      return Number.isNaN(t) ? null : t;
    };
    const cFrom = toMs(adv.createdFrom, false);
    const cTo = toMs(adv.createdTo, true);
    const uFrom = toMs(adv.updatedFrom, false);
    const uTo = toMs(adv.updatedTo, true);

    const inRange = (iso: string, from: number | null, to: number | null) => {
      if (from === null && to === null) return true;
      const t = new Date(iso).getTime();
      if (Number.isNaN(t)) return false;
      if (from !== null && t < from) return false;
      if (to !== null && t > to) return false;
      return true;
    };

    return filteredByCustomDir
      .filter((r) => {
        const title = stripDirTag(r.title);
        if (q && !title.toLowerCase().includes(q)) return false;
        if (!matchesText(r.createdBy, adv.createdBy)) return false;
        if (!matchesText(r.updatedBy, adv.updatedBy)) return false;
        if (!inRange(r.createdAt, cFrom, cTo)) return false;
        if (!inRange(r.updatedAt, uFrom, uTo)) return false;
        if (adv.linkedCases === "linked" && r.linkedCaseCount <= 0) return false;
        if (adv.linkedCases === "unlinked" && r.linkedCaseCount > 0)
          return false;
        return true;
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [adv, filteredByCustomDir]);

  const designPager = usePagination(listRows, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.testDesign",
  });
  const pagedDesignRows = designPager.pagedItems;
  const pagedDesignRowsRef = useRef(pagedDesignRows);
  pagedDesignRowsRef.current = pagedDesignRows;
  const pagedDesignRowIdsRef = useRef<string[]>([]);
  pagedDesignRowIdsRef.current = pagedDesignRows.map((r) => r.id);
  const allDesignListRowIds = useMemo(
    () => listRows.map((r) => r.id),
    [listRows],
  );
  const selectedDesignIdsRef = useRef(selectedDesignIds);
  selectedDesignIdsRef.current = selectedDesignIds;

  const { onRowCheckboxPointerDown, tableBodyRef: designTableBodyRef } =
    useRowCheckboxBrushByIds({
      pagedRowIdsRef: pagedDesignRowIdsRef,
      selectedIdsRef: selectedDesignIdsRef,
      setSelectedIds: setSelectedDesignIds,
    });

  const toggleSelectAllDesignPage = useCallback(() => {
    setSelectedDesignIds((prev) => {
      const rows = pagedDesignRowsRef.current;
      const all = rows.map((r) => r.id);
      const pageSet = new Set(all);
      const allOnPageSelected =
        all.length > 0 && all.every((id) => prev.includes(id));
      return allOnPageSelected
        ? prev.filter((id) => !pageSet.has(id))
        : Array.from(new Set([...prev, ...all]));
    });
  }, []);

  /** 与分页「/ 总数」一致：当前筛选下列表全部行 */
  const toggleSelectAllDesignFullVisible = useCallback(() => {
    const ids = allDesignListRowIds;
    if (ids.length === 0) return;
    setSelectedDesignIds((prev) => {
      const fullSet = new Set(ids);
      const exact =
        prev.length === ids.length &&
        prev.every((id) => fullSet.has(id));
      if (exact) return [];
      return [...ids];
    });
  }, [allDesignListRowIds]);

  const runBatchExport = useCallback(async () => {
    if (selectedDesignIds.length === 0) return;
    setBatchWorking(true);
    const r = await getTestDesignsExportRows(selectedDesignIds);
    setBatchWorking(false);
    if (r.error || !r.rows) return;
    const rows = r.rows;
    const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
    const csvEscape = (val: string) => {
      const s = String(val).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [
      headers.map((h) => csvEscape(h)).join(","),
      ...rows.map((row) =>
        headers
          .map((h) =>
            csvEscape(
              (row as unknown as Record<string, string | null | undefined>)[h] ?? "",
            ),
          )
          .join(","),
      ),
    ];
    const csv = "\uFEFF" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `测试设计导出_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, [selectedDesignIds]);

  const bulkEditTreeOptions = useMemo(() => {
    const out: Array<{ value: string; label: string }> = [];
    for (const t of testDesignTypeOptions) {
      out.push({ value: `type:${t.value}`, label: t.label });
      const dirs = customDirs.filter((d) => d.parentType === t.value);
      const tree = buildCustomDirTree(dirs);
      const walk = (nodes: CustomDirNode[], depth: number) => {
        for (const n of nodes) {
          const indent = `${"—".repeat(Math.min(12, (depth + 1) * 2))} `;
          out.push({ value: `dir:${n.id}`, label: `${indent}${n.label}`.trim() });
          if (n.children.length > 0) walk(n.children, depth + 1);
        }
      };
      walk(tree, 0);
    }
    return out;
  }, [customDirs]);

  const runBatchEdit = useCallback(async () => {
    if (selectedDesignIds.length === 0) return;
    if (!bulkEditType && !bulkEditDirId) {
      window.alert("请至少选择一个要修改的字段（类别或目录）。");
      return;
    }
    setBatchWorking(true);
    const r = await bulkUpdateTestDesignNodes({
      ids: selectedDesignIds,
      type: bulkEditType ? bulkEditType : null,
      dirId:
        bulkEditDirId === ""
          ? undefined
          : bulkEditDirId === "__clear__"
            ? null
            : bulkEditDirId,
    });
    setBatchWorking(false);
    if (r.error) {
      window.alert(r.error);
      return;
    }
    setBulkEditOpen(false);
    setBulkEditType("");
    setBulkEditDirId("");
    await reload();
    setDesignRevision((x) => x + 1);
  }, [bulkEditDirId, bulkEditType, reload, selectedDesignIds]);

  const runBatchDelete = useCallback(async () => {
    if (selectedDesignIds.length === 0) return;
    if (!window.confirm(`确定批量删除已选 ${selectedDesignIds.length} 条设计？`)) return;
    setBatchWorking(true);
    const r = await bulkDeleteTestDesignNodes(selectedDesignIds);
    setBatchWorking(false);
    if (r.error) return;
    setSelectedDesignIds([]);
    await reload();
    setDesignRevision((x) => x + 1);
  }, [reload, selectedDesignIds]);

  const runBatchDuplicate = useCallback(async () => {
    if (selectedDesignIds.length === 0) return;
    setBatchWorking(true);
    const dirId =
      activeCustomDir && activeCustomDir.parentType === category
        ? activeCustomDir.id
        : null;
    const r = await bulkDuplicateTestDesignNodes({
      ids: selectedDesignIds,
      targetType: category,
      targetDirId: dirId,
    });
    setBatchWorking(false);
    if (r.error) return;
    setSelectedDesignIds([]);
    await reload();
    setDesignRevision((x) => x + 1);
  }, [activeCustomDir, category, reload, selectedDesignIds]);

  const runBatchMove = useCallback(async () => {
    if (selectedDesignIds.length === 0) return;
    setMoveTargetIterationCode(iterationCode);
    setMoveTargetReqId(selectedReqId);
    setMoveModalOpen(true);
  }, [selectedDesignIds.length, selectedReqId]);

  useEffect(() => {
    if (!moveModalOpen) return;
    (async () => {
      const code = moveTargetIterationCode.trim();
      const rows = await listRequirementsForDesignTree(code ? code : undefined);
      setMoveReqOptions(rows);
      // 若当前目标不在列表中，则默认选中第一条
      if (!rows.some((r) => r.id === moveTargetReqId)) {
        setMoveTargetReqId(rows[0]?.id ?? "");
      }
    })();
  }, [moveModalOpen, moveTargetIterationCode, moveTargetReqId]);

  const confirmBatchMove = useCallback(async () => {
    setBatchWorking(true);
    const r = await bulkMoveTestDesignNodes({
      ids: selectedDesignIds,
      targetRequirementId: moveTargetReqId,
    });
    setBatchWorking(false);
    if (r.error) return;
    setMoveModalOpen(false);
    setSelectedDesignIds([]);
    await reload();
    setDesignRevision((x) => x + 1);
  }, [moveTargetReqId, reload, selectedDesignIds]);

  const runBatchImport = useCallback(() => {
    const ids = selectedDesignIdsRef.current;
    if (ids.length === 0) return;
    try {
      writePendingTestDesignImport({
        ids,
        productId: productId.trim() || undefined,
      });
    } catch {
      window.alert("无法写入待导入数据，请检查浏览器是否禁用了本地存储。");
      return;
    }
    window.location.assign("/test-cases?designImport=1");
  }, [productId]);

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    if (selectedDesignIds.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const all = pagedDesignRows.map((r) => r.id);
    const set = new Set(selectedDesignIds);
    const allSelected = all.length > 0 && all.every((id) => set.has(id));
    el.indeterminate = !allSelected;
    el.checked = allSelected;
  }, [pagedDesignRows, selectedDesignIds]);

  useEffect(() => {
    const el = selectAllFullVisibleRef.current;
    if (!el) return;
    const ids = allDesignListRowIds;
    if (ids.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const fullSet = new Set(ids);
    const exactAll =
      selectedDesignIds.length === ids.length &&
      selectedDesignIds.every((id) => fullSet.has(id));
    const someInList = ids.some((id) => selectedDesignIds.includes(id));
    el.checked = exactAll;
    el.indeterminate = someInList && !exactAll;
  }, [allDesignListRowIds, selectedDesignIds]);
  const reqById = useMemo(() => new Map(reqFlat.map((r) => [r.id, r])), [reqFlat]);

  const moveReqSelectOptions = useMemo(() => {
    const tree = buildTree(moveReqOptions);
    const sortRec = (nodes: ReqNode[]): ReqNode[] =>
      [...nodes]
        .map((n) => ({ ...n, children: sortRec(n.children) }))
        .sort(
          (a, b) =>
            compareWbsId(a.wbsId, b.wbsId) ||
            a.title.localeCompare(b.title, "zh-CN"),
        );
    const sorted = sortRec(tree);
    const out: Array<{ id: string; label: string }> = [];
    const walk = (nodes: ReqNode[], depth: number) => {
      for (const n of nodes) {
        const indent = depth <= 0 ? "" : `${"—".repeat(Math.min(12, depth * 2))} `;
        const wbs = n.wbsId?.trim() ? `${n.wbsId} ` : "";
        const iter = n.iterationLabel ? `${n.iterationLabel} / ` : "";
        out.push({ id: n.id, label: `${indent}${iter}${wbs}${n.title}`.trim() });
        if (n.children.length > 0) walk(n.children, depth + 1);
      }
    };
    walk(sorted, 0);
    return out;
  }, [moveReqOptions]);

  /** 整需求迁入：源需求下拉（当前迭代需求树，排除当前选中需求） */
  const moveAllReqSelectOptions = useMemo(() => {
    if (!selectedReqId) return [];
    const tree = buildTree(reqFlat.filter((r) => r.id !== selectedReqId));
    const sortRec = (nodes: ReqNode[]): ReqNode[] =>
      [...nodes]
        .map((n) => ({ ...n, children: sortRec(n.children) }))
        .sort(
          (a, b) =>
            compareWbsId(a.wbsId, b.wbsId) ||
            a.title.localeCompare(b.title, "zh-CN"),
        );
    const sorted = sortRec(tree);
    const out: Array<{ id: string; label: string }> = [];
    const walk = (nodes: ReqNode[], depth: number) => {
      for (const n of nodes) {
        const indent = depth <= 0 ? "" : `${"—".repeat(Math.min(12, depth * 2))} `;
        const wbs = n.wbsId?.trim() ? `${n.wbsId} ` : "";
        const iter = n.iterationLabel ? `${n.iterationLabel} / ` : "";
        out.push({ id: n.id, label: `${indent}${iter}${wbs}${n.title}`.trim() });
        if (n.children.length > 0) walk(n.children, depth + 1);
      }
    };
    walk(sorted, 0);
    return out;
  }, [reqFlat, selectedReqId]);

  const designSumAllCategories = useMemo(
    () => Object.values(countsByType).reduce((a, b) => a + b, 0),
    [countsByType],
  );

  const selectedReqTitle = selectedReqId ? reqById.get(selectedReqId)?.title : "";

  const confirmMoveAllFromRequirement = useCallback(async () => {
    if (!selectedReqId || !moveAllSourceReqId) return;
    const title = reqById.get(selectedReqId)?.title ?? selectedReqId;
    setBatchWorking(true);
    const r = await bulkMoveAllTestDesignsBetweenRequirements({
      sourceRequirementId: moveAllSourceReqId,
      targetRequirementId: selectedReqId,
    });
    setBatchWorking(false);
    if (r.error) {
      window.alert(r.error);
      return;
    }
    window.alert(
      r.moved !== undefined
        ? `已迁入 ${r.moved} 条测试设计到当前需求「${title}」。`
        : "迁入完成。",
    );
    setMoveAllModalOpen(false);
    setMoveAllSourceReqId("");
    await reload();
    setDesignRevision((x) => x + 1);
  }, [moveAllSourceReqId, reload, reqById, selectedReqId]);

  const addRoot = async () => {
    if (!selectedReqId) return;
    setRootBusy(true);
    setRootErr(null);
    const dirId =
      activeCustomDir && activeCustomDir.parentType === category
        ? activeCustomDir.id
        : null;
    const r = await createTestDesignNode({
      requirementId: selectedReqId,
      parentId: null,
      title: rootTitle,
      type: category,
      iterationCode: iterationCode === "" ? "" : iterationCode,
      dirId,
    });
    setRootBusy(false);
    if (r.error) {
      setRootErr(r.error);
      return;
    }
    setRootTitle("");
    await reload();
    setDesignRevision((x) => x + 1);
  };

  return (
    <>
    <ModuleWorkspaceCard
      className={[
        "flex h-full min-h-0 flex-col",
        topPaneCollapsed || topPaneMaximized ? "rounded-lg" : "",
      ].join(" ")}
    >
      <div
        ref={workspaceLayoutRef}
        className="flex h-full min-h-0 flex-col overflow-hidden"
      >
        <div
          className={[
            "relative overflow-hidden bg-zinc-50/60 px-3 sm:px-4",
            topPaneCollapsed
              ? "h-0 shrink-0 overflow-visible border-0 p-0"
              : topPaneMaximized
                ? "flex min-h-0 flex-1 flex-col overflow-hidden py-2"
                : "shrink-0 overflow-hidden border-b border-zinc-200 py-2",
          ].join(" ")}
          style={
            topPaneCollapsed || topPaneMaximized
              ? undefined
              : { height: topPaneH, minHeight: 0 }
          }
        >
          {!topPaneCollapsed ? (
            <div
              className={
                topPaneMaximized
                  ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                  : undefined
              }
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2 gap-y-1">
                <h2 className="text-xs font-semibold text-zinc-900">需求目录</h2>
                <p className="hidden max-w-2xl text-[11px] leading-snug text-zinc-500 sm:block">
                  在上方选择<strong>需求节点</strong>，下方可切换类别并维护测试设计；点击设计标题进入详情并
                  <strong>关联用例</strong>。
                </p>
              </div>
              <div className="mt-2 flex flex-wrap items-end gap-3 gap-y-2">
                <div className="min-w-[min(100%,10rem)] flex-1 sm:flex-initial sm:min-w-[180px]">
                  <label className="text-xs font-medium text-zinc-600">
                    切换产品
                  </label>
                  <select
                    className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm"
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code ? `${p.name}（${p.code}）` : p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-[min(100%,10rem)] flex-1 sm:flex-initial sm:min-w-[180px]">
                  <label className="text-xs font-medium text-zinc-600">
                    迭代筛选
                  </label>
                  <select
                    className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm"
                    value={iterationCode}
                    onChange={(e) => setIterationCode(e.target.value)}
                    title="baseline 表示查看全部迭代"
                  >
                    {visibleIterations.map((o) => (
                      <option key={o.code || "__baseline__"} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-[min(100%,12rem)] flex-1 sm:min-w-[200px]">
                  <label className="text-xs font-medium text-zinc-600">
                    模糊查询（需求/设计）
                  </label>
                  <input
                    type="search"
                    autoComplete="off"
                    className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm"
                    placeholder="关键字筛选需求（右侧可筛设计）"
                    value={reqSearch}
                    onChange={(e) => setReqSearch(e.target.value)}
                  />
                </div>
              </div>
              <div
                ref={reqTreeScrollRef}
                className={[
                  "mt-2 min-h-0 overflow-y-auto rounded-md border border-zinc-200/90 bg-white/90 px-2 py-1.5 text-xs leading-tight",
                  topPaneMaximized ? "flex-1" : "",
                ].join(" ")}
                style={
                  topPaneMaximized
                    ? undefined
                    : { height: Math.max(0, topPaneH - 88) }
                }
              >
                {reqTree.length === 0 ? (
                  <p className="text-xs text-zinc-500">
                    暂无需求，请先在「需求管理」中创建需求节点。
                  </p>
                ) : (
                  <ul className="space-y-0.5" role="tree">
                    {reqTree.map((n) => (
                      <ReqTreeRows
                        key={n.id}
                        node={n}
                        depth={0}
                        selectedId={selectedReqId}
                        onSelect={setSelectedReqId}
                        countByReqId={reqDesignCounts}
                        expandedById={expandedReq}
                        onToggle={(id) =>
                          setExpandedReq((p) => ({ ...p, [id]: !(p[id] ?? true) }))
                        }
                      />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
          <div
            className={[
              "absolute left-0 right-0 z-30 h-2 cursor-row-resize hover:bg-zinc-300/30",
              topPaneCollapsed ? "top-0" : "bottom-0",
            ].join(" ")}
            role="separator"
            aria-label="拖动调整顶部需求目录高度"
            title={
              topPaneCollapsed
                ? "向下拖展开需求目录"
                : topPaneMaximized
                  ? "向上拖展开类别与设计列表"
                  : "拖动调整高度（向上可收至顶部以扩大设计区，向下可拉满仅展示需求目录）"
            }
            onPointerDown={startResizeTopPane}
            onDoubleClick={() => restoreTopPane()}
          />
        </div>

        {!topPaneMaximized ? (
        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white">
          {topPaneCollapsed ? (
            <button
              type="button"
              onClick={restoreTopPane}
              className="absolute left-0 top-0 z-40 hidden h-full w-2 shrink-0 cursor-col-resize border-0 bg-zinc-200/90 p-0 hover:bg-sky-400/35 lg:block"
              title="点击展开需求目录与类别侧栏"
              aria-label="点击展开需求目录与类别侧栏"
            />
          ) : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
            {!topPaneCollapsed ? (
            <section
              className="relative flex min-h-0 flex-col bg-zinc-50/60 lg:min-h-0 lg:min-h-[180px] lg:border-r lg:border-zinc-200"
              style={{ width: catPaneW }}
            >
              <div className="shrink-0 border-b border-zinc-200/80 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-zinc-900">类别</h3>
                  <button
                    type="button"
                    className="text-xs font-medium text-blue-700 hover:underline"
                    onClick={() => setCategoryEditOpen((o) => !o)}
                  >
                    {categoryEditOpen ? "完成" : "编辑"}
                  </button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
                <ul className="space-y-0.5">
                  {visibleCategories.map((o) => (
                    <li key={o.key}>
                      {(() => {
                        const dirs = visibleCustomDirsByType.get(o.key) ?? [];
                        const tree = buildCustomDirTree(dirs);
                        const toggleDirExpand = (id: string) => {
                          setDirExpandedById((prev) => ({ ...prev, [id]: !(prev[id] ?? true) }));
                        };

                        const doMoveDir = async (input: {
                          dirId: string;
                          targetType: TestDesignType;
                          targetParentId: string | null;
                        }) => {
                          const ic = iterationCode.trim();
                          if (!ic) {
                            window.alert("请先选择具体迭代（baseline 不支持维护子目录）。");
                            return;
                          }
                          const r = await moveTestDesignDir({
                            id: input.dirId,
                            iterationCode: ic,
                            targetType: input.targetType,
                            targetParentId: input.targetParentId,
                          });
                          if (r.error) {
                            window.alert(r.error);
                            return;
                          }
                          const r2 = await listTestDesignDirs({ iterationCode: ic });
                          setCustomDirs(
                            (r2.rows ?? []).map((x) => ({
                              id: x.id,
                              label: x.name,
                              parentType: x.type,
                              parentId: x.parentId,
                            })),
                          );
                          setDirExpandedById((prev) => ({
                            ...prev,
                            ...(input.targetParentId ? { [input.targetParentId]: true } : {}),
                          }));
                        };

                        const renderDir = (n: CustomDirNode, depth = 0): React.ReactNode => {
                          const active =
                            category === n.parentType && selectedCustomDirId === n.id;
                          const hasChildren = n.children.length > 0;
                          const expanded = dirExpandedById[n.id] !== false;
                          return (
                            <li key={n.id}>
                              <div
                                className={[
                                  // 子节点：字体更小、行距更紧凑（比根节点小两号）
                                  "flex items-center gap-1 rounded-md px-2 py-1 text-[10px] leading-tight",
                                  active
                                    ? "bg-zinc-200/90 text-zinc-900"
                                    : "hover:bg-zinc-100/80 text-zinc-700",
                                ].join(" ")}
                                style={{ paddingLeft: 8 + (depth + 1) * 12 }}
                                draggable={categoryEditOpen}
                                onDragStart={(e) => {
                                  if (!categoryEditOpen) return;
                                  dragDirIdRef.current = n.id;
                                  try {
                                    e.dataTransfer.effectAllowed = "move";
                                    e.dataTransfer.setData("text/plain", n.id);
                                  } catch {
                                    // ignore
                                  }
                                }}
                                onDragOver={(e) => {
                                  if (!categoryEditOpen) return;
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = "move";
                                }}
                                onDrop={(e) => {
                                  if (!categoryEditOpen) return;
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const dragged = dragDirIdRef.current;
                                  dragDirIdRef.current = null;
                                  if (!dragged || dragged === n.id) return;
                                  void doMoveDir({
                                    dirId: dragged,
                                    targetType: n.parentType,
                                    targetParentId: n.id,
                                  });
                                }}
                              >
                                <button
                                  type="button"
                                  className={[
                                    "h-5 w-5 shrink-0 self-center rounded text-[10px] leading-none text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700",
                                    hasChildren ? "visible" : "invisible pointer-events-none",
                                  ].join(" ")}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    toggleDirExpand(n.id);
                                  }}
                                  aria-label={expanded ? "收起子目录" : "展开子目录"}
                                  title={expanded ? "收起" : "展开"}
                                >
                                  {expanded ? "▾" : "▸"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCategory(n.parentType);
                                    setSelectedCustomDirId(n.id);
                                  }}
                                  className="min-w-0 flex-1 truncate text-left font-medium"
                                  title={n.label}
                                >
                                  {n.label}
                                </button>
                                <span
                                  className="shrink-0 tabular-nums text-zinc-400"
                                  title="该目录及子目录下的设计数（随当前迭代/需求筛选）"
                                >
                                  ({dirCountsById[n.id] ?? 0})
                                </span>
                                {categoryEditOpen ? (
                                  <>
                                    <button
                                      type="button"
                                      className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                                      onClick={async (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        const ic = iterationCode.trim();
                                        if (!ic) {
                                          window.alert(
                                            "请先选择具体迭代（baseline 不支持维护子目录）。",
                                          );
                                          return;
                                        }
                                        const next = window.prompt("新增子目录", "");
                                        if (!next || !next.trim()) return;
                                        try {
                                          const r = await createTestDesignDir({
                                            iterationCode: ic,
                                            type: n.parentType,
                                            parentId: n.id,
                                            name: next.trim(),
                                          });
                                          if (r.error) {
                                            window.alert(r.error);
                                            return;
                                          }
                                          const r2 = await listTestDesignDirs({
                                            iterationCode: ic,
                                          });
                                          setCustomDirs(
                                            (r2.rows ?? []).map((x) => ({
                                              id: x.id,
                                              label: x.name,
                                              parentType: x.type,
                                              parentId: x.parentId,
                                            })),
                                          );
                                        } catch (err) {
                                          window.alert(
                                            err instanceof Error
                                              ? err.message
                                              : "新增目录失败",
                                          );
                                        }
                                      }}
                                      title="新增子节点"
                                    >
                                      +子
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                                      onClick={async (e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        const next = window.prompt("重命名目录", n.label);
                                        if (!next || !next.trim()) return;
                                        try {
                                          const r = await renameTestDesignDir({
                                            id: n.id,
                                            name: next.trim(),
                                          });
                                          if (r.error) {
                                            window.alert(r.error);
                                            return;
                                          }
                                          const r2 = await listTestDesignDirs({
                                            iterationCode,
                                          });
                                          setCustomDirs(
                                            (r2.rows ?? []).map((x) => ({
                                              id: x.id,
                                              label: x.name,
                                              parentType: x.type,
                                              parentId: x.parentId,
                                            })),
                                          );
                                        } catch (err) {
                                          window.alert(
                                            err instanceof Error ? err.message : "重命名失败",
                                          );
                                        }
                                      }}
                                    >
                                      改
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded border border-red-200 bg-white px-1.5 py-0.5 text-xs text-red-700 hover:bg-red-50"
                                      title="从侧栏删除该目录：存在归属该目录的设计时不可删除"
                                      onClick={() => void confirmHideCustomDir(n.id, n.label)}
                                    >
                                      删
                                    </button>
                                  </>
                                ) : null}
                              </div>
                              {hasChildren && expanded ? (
                                <div className="relative ml-1.5 border-l border-dashed border-zinc-200 pl-0.5">
                                  <ul className="space-y-0" role="group">
                                    {n.children.map((c) => renderDir(c, depth + 1))}
                                  </ul>
                                </div>
                              ) : null}
                            </li>
                          );
                        };

                        return (
                          <>
                            <div
                              className={[
                                "flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
                                category === o.key
                                  ? "bg-zinc-200/90 text-zinc-900"
                                  : "hover:bg-zinc-100/80 text-zinc-700",
                              ].join(" ")}
                              onDragOver={(e) => {
                                if (!categoryEditOpen) return;
                                e.preventDefault();
                                e.dataTransfer.dropEffect = "move";
                              }}
                              onDrop={(e) => {
                                if (!categoryEditOpen) return;
                                e.preventDefault();
                                e.stopPropagation();
                                const dragged = dragDirIdRef.current;
                                dragDirIdRef.current = null;
                                if (!dragged) return;
                                void doMoveDir({
                                  dirId: dragged,
                                  targetType: o.key,
                                  targetParentId: null,
                                });
                              }}
                            >
                              <button
                                type="button"
                                onClick={() => {
                                  setCategory(o.key);
                                  setSelectedCustomDirId(null);
                                }}
                                className="min-w-0 flex-1 truncate text-left font-medium"
                                title={o.label}
                              >
                                {o.label}
                              </button>
                              <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
                                {countsByType[o.key]}
                              </span>
                              {categoryEditOpen ? (
                                <>
                                  <button
                                    type="button"
                                    className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                                    onClick={async (e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      const ic = iterationCode.trim();
                                      if (!ic) {
                                        window.alert(
                                          "请先选择具体迭代（baseline 不支持维护子目录）。",
                                        );
                                        return;
                                      }
                                      const next = window.prompt(
                                        `新增「${o.label}」子节点`,
                                        "",
                                      );
                                      if (!next || !next.trim()) return;
                                      try {
                                        const r = await createTestDesignDir({
                                          iterationCode: ic,
                                          type: o.key,
                                          parentId: null,
                                          name: next.trim(),
                                        });
                                        if (r.error) {
                                          window.alert(r.error);
                                          return;
                                        }
                                        const r2 = await listTestDesignDirs({
                                          iterationCode: ic,
                                        });
                                        setCustomDirs(
                                          (r2.rows ?? []).map((x) => ({
                                            id: x.id,
                                            label: x.name,
                                            parentType: x.type,
                                            parentId: x.parentId,
                                          })),
                                        );
                                      } catch (err) {
                                        window.alert(
                                          err instanceof Error ? err.message : "新增目录失败",
                                        );
                                      }
                                    }}
                                    title="新增子节点"
                                  >
                                    +子
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                                    onClick={() => {
                                      const next = window.prompt("重命名类别", o.label);
                                      if (!next || !next.trim()) return;
                                      setCategories((prev) =>
                                        prev.map((x) =>
                                          x.key === o.key
                                            ? { ...x, label: next.trim() }
                                            : x,
                                        ),
                                      );
                                    }}
                                  >
                                    改
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded border border-red-200 bg-white px-1.5 py-0.5 text-xs text-red-700 hover:bg-red-50"
                                    onClick={() => void confirmHideCategory(o.key, o.label)}
                                    title="从侧栏删除该类别：存在测试设计数据时不可删除"
                                  >
                                    删
                                  </button>
                                </>
                              ) : null}
                            </div>
                            {tree.length > 0 ? (
                              <ul className="mt-0.5 space-y-0" role="group">
                                {tree.map((n) => renderDir(n, 0))}
                              </ul>
                            ) : null}
                          </>
                        );
                      })()}
                    </li>
                  ))}
                </ul>
                {categoryEditOpen ? (
                  <div className="mt-2 flex flex-col gap-1.5">
                    <button
                      type="button"
                      className="text-left text-xs font-medium text-blue-700 hover:underline"
                      onClick={() => {
                        setNewCustomDirName("");
                        setNewCustomDirOpen(true);
                      }}
                    >
                      + 新增自定义目录
                    </button>
                    <button
                      type="button"
                      className="text-left text-xs font-medium text-blue-700 hover:underline"
                      onClick={openRestoreHiddenModal}
                    >
                      + 新增目录（恢复隐藏）
                    </button>
                  </div>
                ) : null}
              </div>
              <span
                className="absolute right-0 top-0 hidden h-full w-2 cursor-col-resize hover:bg-zinc-300/40 lg:block"
                role="separator"
                title="拖动调整宽度"
                onMouseDown={(e) => {
                  e.preventDefault();
                  startResizeCatPane(e.clientX);
                }}
              />
            </section>
            ) : null}

            <section
              ref={rightPanelRef}
              className={[
                "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white p-4",
                topPaneCollapsed ? "w-full min-w-0" : "",
              ].join(" ")}
            >
              {!selectedReqId ? (
                <div className="min-h-0 flex-1">
                  <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-zinc-200 bg-zinc-50/40 p-6">
                    <p className="text-sm text-zinc-500">请先在上方选择需求节点。</p>
                  </div>
                </div>
              ) : (
                <>
                  <div
                    ref={listToolbarPaneRef}
                    className="shrink-0 overflow-hidden"
                    style={
                      listToolbarPaneH !== null
                        ? { height: listToolbarPaneH, minHeight: 0 }
                        : undefined
                    }
                  >
                  <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                    <div className="min-w-[min(100%,18rem)] flex-1">
                      <label className="text-xs font-medium text-zinc-600">
                        模糊查询（设计）
                      </label>
                      <input
                        type="search"
                        autoComplete="off"
                        className="mt-1 w-full max-w-md rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        placeholder={`当前：${selectedReqTitle || "未选择需求"} / ${testDesignTypeLabel[category]}`}
                        value={designSearch}
                        onChange={(e) => setDesignSearch(e.target.value)}
                      />
                      <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-zinc-600">
                        需求树旁数字 = 当前迭代下该需求的<strong>全部类别</strong>合计（
                        {designSumAllCategories} 条）；右侧列表默认只看<strong>当前类别</strong>「
                        {testDesignTypeLabel[category]}」（{countsByType[category] ?? 0}
                        条），并受目录与筛选影响（当前匹配 {listRows.length} 条）。
                        若设计挂在<strong>其他需求</strong>上，请用「整需求迁入」。
                      </p>
                    </div>
                    <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!iterationCode.trim() || !selectedReqId}
                        title={
                          !iterationCode.trim()
                            ? "请先选择具体迭代"
                            : !selectedReqId
                              ? "请先选择需求"
                              : "将另一需求下的全部测试设计迁入当前需求"
                        }
                        className={MODULE_TOOLBAR_BTN_SECONDARY}
                        onClick={() => {
                          setMoveAllSourceReqId(moveAllReqSelectOptions[0]?.id ?? "");
                          setMoveAllModalOpen(true);
                        }}
                      >
                        整需求迁入
                      </button>
                      <button
                        type="button"
                        onClick={() => setAdvOpen((o) => !o)}
                        className={MODULE_TOOLBAR_BTN_SECONDARY}
                        aria-expanded={advOpen}
                      >
                        <span>高级筛选</span>{" "}
                        <span className="ml-1 text-xs text-zinc-500">
                          {advOpen ? "▼" : "▶"}
                        </span>
                      </button>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setDesignGearOpen((o) => !o)}
                          className={MODULE_TOOLBAR_BTN_SECONDARY}
                          title="列表列设置（显隐、顺序；表头可拖竖线调宽）"
                          aria-expanded={designGearOpen}
                          aria-haspopup="true"
                          aria-label="测试设计列表列设置"
                        >
                          ⚙
                        </button>
                        {designGearOpen ? (
                          <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-[320px] rounded-xl border border-zinc-200 bg-white p-2 shadow-xl">
                            <div className="px-2 pb-2 text-xs font-medium text-zinc-500">
                              列设置
                            </div>
                            <div className="max-h-[320px] overflow-auto">
                              {designColConfig.order.map((k, idx) => (
                                <div
                                  key={k}
                                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50"
                                >
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-zinc-300 disabled:opacity-60"
                                    checked={designColConfig.visible[k] !== false}
                                    disabled={isTestDesignColumnPinned(k)}
                                    title={
                                      isTestDesignColumnPinned(k)
                                        ? "标题列始终显示"
                                        : undefined
                                    }
                                    onChange={(e) =>
                                      setDesignColVisible(k, e.target.checked)
                                    }
                                  />
                                  <div className="flex-1 text-sm text-zinc-800">
                                    {TEST_DESIGN_COLUMN_LABELS[k]}
                                  </div>
                                  <button
                                    type="button"
                                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                                    disabled={idx === 0}
                                    onClick={() => moveDesignCol(k, -1)}
                                    title="上移"
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                                    disabled={idx === designColConfig.order.length - 1}
                                    onClick={() => moveDesignCol(k, 1)}
                                    title="下移"
                                  >
                                    ↓
                                  </button>
                                </div>
                              ))}
                            </div>
                            <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-100 pt-2">
                              <button
                                type="button"
                                className="rounded-lg border border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                                onClick={() => resetDesignCols()}
                              >
                                重置默认
                              </button>
                              <button
                                type="button"
                                className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white"
                                onClick={() => setDesignGearOpen(false)}
                              >
                                关闭
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        disabled={!selectedReqId}
                        onClick={addRoot}
                        className={MODULE_TOOLBAR_BTN_PRIMARY}
                        title="在当前类别下创建一个根节点"
                      >
                        在当前类别新建设计
                      </button>
                    </div>
                  </div>
                  {rootErr && (
                    <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                      {rootErr}
                    </p>
                  )}
                  <div className="mb-3 rounded-lg border border-zinc-100 bg-zinc-50/50 p-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      新建（当前类别：{testDesignTypeLabel[category]})
                    </h3>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        className="min-w-[180px] flex-1 rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        placeholder="根节点标题"
                        value={rootTitle}
                        onChange={(e) => setRootTitle(e.target.value)}
                      />
                      <button
                        type="button"
                        disabled={rootBusy}
                        onClick={addRoot}
                        className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                      >
                        新建
                      </button>
                    </div>
                  </div>

                  {advOpen ? (
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50/60">
                      <div className="px-3 pb-3 pt-3">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          <div>
                            <label className="text-xs font-medium text-zinc-600">
                              标题包含
                            </label>
                            <input
                              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                              value={adv.titleContains}
                              onChange={(e) =>
                                setAdv((p) => ({
                                  ...p,
                                  titleContains: e.target.value,
                                }))
                              }
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-zinc-600">
                              创建人包含
                            </label>
                            <input
                              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                              value={adv.createdBy}
                              onChange={(e) =>
                                setAdv((p) => ({
                                  ...p,
                                  createdBy: e.target.value,
                                }))
                              }
                            />
                          </div>
                          <div>
                            <label className="text-xs font-medium text-zinc-600">
                              修改人包含
                            </label>
                            <input
                              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                              value={adv.updatedBy}
                              onChange={(e) =>
                                setAdv((p) => ({
                                  ...p,
                                  updatedBy: e.target.value,
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
                              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                              value={adv.createdFrom}
                              onChange={(e) =>
                                setAdv((p) => ({
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
                              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                              value={adv.createdTo}
                              onChange={(e) =>
                                setAdv((p) => ({
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
                              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                              value={adv.updatedFrom}
                              onChange={(e) =>
                                setAdv((p) => ({
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
                              className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                              value={adv.updatedTo}
                              onChange={(e) =>
                                setAdv((p) => ({
                                  ...p,
                                  updatedTo: e.target.value,
                                }))
                              }
                            />
                          </div>
                        </div>
                        <div className="mt-3 flex justify-end">
                          <button
                            type="button"
                            className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                            onClick={() =>
                              setAdv({
                                titleContains: "",
                                createdBy: "",
                                updatedBy: "",
                                createdFrom: "",
                                createdTo: "",
                                updatedFrom: "",
                                updatedTo: "",
                                linkedCases: "all",
                              })
                            }
                          >
                            重置筛选
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  </div>

                  <div className="relative flex min-h-0 flex-1 flex-col pt-1">
                    {listToolbarPaneCollapsed ? (
                      <button
                        type="button"
                        onClick={restoreListToolbarPane}
                        className="absolute left-1/2 top-0 z-30 -translate-x-1/2 -translate-y-1/2 rounded-full border border-zinc-200 bg-white px-3 py-0.5 text-xs font-semibold text-zinc-700 shadow-sm hover:bg-zinc-50"
                        title="展开查询与工具栏"
                        aria-label="展开查询与工具栏"
                      >
                        ↓
                      </button>
                    ) : null}
                    <div
                      className="absolute left-0 right-0 top-0 z-20 h-2 -translate-y-1/2 cursor-row-resize hover:bg-zinc-300/30"
                      role="separator"
                      aria-label="拖动调整查询与工具栏区域高度"
                      title="向上拖：收起查询/工具栏以扩大列表；向下拖：展开工具栏（列表至少保留约 200px）"
                      onPointerDown={startResizeListToolbarPane}
                      onDoubleClick={() => restoreListToolbarPane()}
                    />
                  {loading ? (
                    <div className="min-h-0 flex-1">
                      <div className="flex h-full items-center justify-center">
                        <p className="text-sm text-zinc-500">加载中…</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      {selectedDesignIds.length > 0 ? (
                        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/90 px-3 py-2.5 text-sm text-zinc-800">
                          <span>
                            已选{" "}
                            <strong className="tabular-nums">
                              {selectedDesignIds.length}
                            </strong>{" "}
                            条
                          </span>
                          <span className="hidden text-zinc-400 sm:inline">|</span>
                          <button
                            type="button"
                            disabled={batchWorking}
                            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                            onClick={runBatchExport}
                          >
                            批量导出 CSV
                          </button>
                          <button
                            type="button"
                            disabled={batchWorking}
                            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                            onClick={runBatchDuplicate}
                            title="复制后将生成新设计；不复制关联用例与操作记录"
                          >
                            批量复制
                          </button>
                          <button
                            type="button"
                            disabled={batchWorking}
                            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                            onClick={runBatchMove}
                          >
                            批量移动
                          </button>
                          <button
                            type="button"
                            disabled={batchWorking}
                            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                            onClick={() => {
                              setBulkEditType("");
                              setBulkEditDirId("");
                              setBulkEditOpen(true);
                            }}
                          >
                            批量修改
                          </button>
                          <button
                            type="button"
                            disabled={batchWorking}
                            title="打开测试用例库，在左侧目录树（与日常一致）中选择目标文件夹后确认导入"
                            className="rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50"
                            onClick={runBatchImport}
                          >
                            批量导入到用例库
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
                            onClick={() => setSelectedDesignIds([])}
                          >
                            取消选择
                          </button>
                        </div>
                      ) : null}

                      <div className="flex min-h-0 flex-1 flex-col">
                        <div className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border border-zinc-200 bg-white">
                          <table
                            className="table-fixed text-left text-sm"
                            style={{
                              width: designTableMinW,
                              minWidth: designTableMinW,
                            }}
                          >
                          <thead className="border-b border-zinc-200 bg-zinc-50/80 text-xs text-zinc-500">
                            <tr>
                              <th className="w-16 min-w-[4rem] py-2.5 pr-2 text-left align-bottom font-medium">
                                <div className="flex items-end gap-1">
                                  <input
                                    ref={selectAllRef}
                                    type="checkbox"
                                    className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                    title="全选当前页（可与其它页已选合并）"
                                    onChange={toggleSelectAllDesignPage}
                                    aria-label="全选当前页"
                                  />
                                  <input
                                    ref={selectAllFullVisibleRef}
                                    type="checkbox"
                                    className="h-4 w-4 shrink-0 rounded border-zinc-300"
                                    title="全选列表：选中当前筛选下全部测试设计（与分页「/ 总数」一致）"
                                    onChange={toggleSelectAllDesignFullVisible}
                                    aria-label="全选全部可见测试设计"
                                  />
                                </div>
                              </th>
                              {designVisibleOrdered.map((k, idx) => {
                                const w = designWidthFor(k);
                                const isLast =
                                  idx === designVisibleOrdered.length - 1;
                                return (
                                  <th
                                    key={k}
                                    className={[
                                      "relative select-none py-2.5 text-left align-bottom font-medium",
                                      isLast ? "pr-3" : "pr-2",
                                    ].join(" ")}
                                    style={{ width: w, minWidth: w }}
                                  >
                                    {k === "linkedCases" ? (
                                      <div className="group/lnk inline-flex min-w-0 max-w-full items-center gap-0.5 pr-1">
                                        <span className="min-w-0 shrink truncate leading-tight">
                                          {TEST_DESIGN_COLUMN_LABELS[k]}
                                        </span>
                                        <div className="relative h-4 w-4 shrink-0 rounded-sm focus-within:ring-2 focus-within:ring-zinc-400/50">
                                          <select
                                            className="absolute inset-0 z-10 cursor-pointer opacity-0 focus:outline-none"
                                            value={adv.linkedCases}
                                            title={`筛选关联用例（当前：${LINKED_CASES_HEADER_FILTER_LABEL[adv.linkedCases]}）`}
                                            aria-label={`筛选关联用例，当前为${LINKED_CASES_HEADER_FILTER_LABEL[adv.linkedCases]}`}
                                            onChange={(e) =>
                                              setAdv((p) => ({
                                                ...p,
                                                linkedCases: e.target
                                                  .value as typeof adv.linkedCases,
                                              }))
                                            }
                                            onClick={(e) => e.stopPropagation()}
                                            onMouseDown={(e) =>
                                              e.stopPropagation()
                                            }
                                          >
                                            <option value="all">全部</option>
                                            <option value="linked">
                                              已关联
                                            </option>
                                            <option value="unlinked">
                                              未关联
                                            </option>
                                          </select>
                                          <span
                                            aria-hidden
                                            className="pointer-events-none block h-4 w-4 bg-[length:14px_14px] bg-[position:center] bg-no-repeat opacity-70 transition-opacity group-hover/lnk:opacity-100"
                                            style={{
                                              backgroundImage: `url("${LINKED_CASES_HEADER_CHEVRON}")`,
                                            }}
                                          />
                                        </div>
                                      </div>
                                    ) : (
                                      <span className="block truncate">
                                        {TEST_DESIGN_COLUMN_LABELS[k]}
                                      </span>
                                    )}
                                    <span
                                      className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-zinc-300/40"
                                      role="separator"
                                      title="拖动调整列宽"
                                      onMouseDown={(e) =>
                                        startResizeDesignCol(e, k)
                                      }
                                    />
                                  </th>
                                );
                              })}
                            </tr>
                          </thead>
                          <tbody ref={designTableBodyRef}>
                            {pagedDesignRows.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={designVisibleOrdered.length + 1}
                                  className="py-12 text-center text-sm text-zinc-500"
                                >
                                  {iterationCode === ""
                                    ? "baseline 数据已清空。"
                                    : "暂无数据或不符合筛选条件。"}
                                </td>
                              </tr>
                            ) : (
                            pagedDesignRows.map((r) => (
                              <tr
                                key={r.id}
                                data-pm-row-select={r.id}
                                className="group cursor-pointer border-b border-zinc-100 hover:bg-zinc-50/70"
                                onClick={() => router.push(`/test-design/node/${r.id}`)}
                              >
                                <td
                                  className="w-16 min-w-[4rem] py-2.5 pr-2 align-top"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    className="mt-1 h-4 w-4 rounded border-zinc-300"
                                    checked={selectedDesignIds.includes(r.id)}
                                    onChange={() => {}}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                    }}
                                    onPointerDown={(e) =>
                                      onRowCheckboxPointerDown(e, r.id)
                                    }
                                    onKeyDown={(e) => {
                                      if (e.key !== " " && e.key !== "Enter")
                                        return;
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setSelectedDesignIds((prev) =>
                                        prev.includes(r.id)
                                          ? prev.filter((x) => x !== r.id)
                                          : [...prev, r.id],
                                      );
                                    }}
                                    title="按住并拖动经过多行可连续勾选"
                                    aria-label={`选择 ${stripDirTag(r.title)}`}
                                  />
                                </td>
                                {designVisibleOrdered.map((k, idx) => {
                                  const w = designWidthFor(k);
                                  const isLast =
                                    idx === designVisibleOrdered.length - 1;
                                  const pad = isLast ? "pr-3" : "pr-2";
                                  switch (k) {
                                    case "title":
                                      return (
                                        <td
                                          key={k}
                                          className={`max-w-0 overflow-hidden py-2.5 align-top ${pad}`}
                                          style={{ width: w, minWidth: w }}
                                        >
                                          <Link
                                            href={`/test-design/node/${r.id}`}
                                            className="block truncate text-sm font-medium text-zinc-900 underline-offset-2 hover:underline"
                                            title={stripDirTag(r.title)}
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            {stripDirTag(r.title)}
                                          </Link>
                                        </td>
                                      );
                                    case "linkedCases":
                                      return (
                                        <td
                                          key={k}
                                          className={`py-2.5 align-top ${pad}`}
                                          style={{ width: w, minWidth: w }}
                                        >
                                          {r.linkedCaseCount > 0 ? (
                                            <span className="inline-flex items-center rounded-full border border-emerald-500/80 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800">
                                              已关联
                                            </span>
                                          ) : (
                                            <span className="inline-flex items-center rounded-full border border-red-500/80 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-800">
                                              未关联
                                            </span>
                                          )}
                                        </td>
                                      );
                                    case "type":
                                      return (
                                        <td
                                          key={k}
                                          className={`py-2.5 align-top ${pad}`}
                                          style={{ width: w, minWidth: w }}
                                        >
                                          <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs text-zinc-700">
                                            {testDesignTypeLabel[r.type]}
                                          </span>
                                        </td>
                                      );
                                    case "createdBy":
                                      return (
                                        <td
                                          key={k}
                                          className={`max-w-0 overflow-hidden py-2.5 align-top text-xs text-zinc-600 ${pad}`}
                                          style={{ width: w, minWidth: w }}
                                        >
                                          <span className="block truncate">
                                            {r.createdBy ?? "—"}
                                          </span>
                                        </td>
                                      );
                                    case "updatedBy":
                                      return (
                                        <td
                                          key={k}
                                          className={`max-w-0 overflow-hidden py-2.5 align-top text-xs text-zinc-600 ${pad}`}
                                          style={{ width: w, minWidth: w }}
                                        >
                                          <span className="block truncate">
                                            {r.updatedBy ?? "—"}
                                          </span>
                                        </td>
                                      );
                                    case "createdAt":
                                      return (
                                        <td
                                          key={k}
                                          className={`py-2.5 align-top text-xs text-zinc-600 tabular-nums ${pad}`}
                                          style={{ width: w, minWidth: w }}
                                        >
                                          {r.createdAt}
                                        </td>
                                      );
                                    case "updatedAt":
                                      return (
                                        <td
                                          key={k}
                                          className={`py-2.5 align-top text-xs text-zinc-600 tabular-nums ${pad}`}
                                          style={{ width: w, minWidth: w }}
                                        >
                                          {r.updatedAt}
                                        </td>
                                      );
                                    default:
                                      return null;
                                  }
                                })}
                              </tr>
                            ))
                            )}
                          </tbody>
                          </table>
                        </div>
                        <div className="shrink-0">
                          <PaginationBar
                            page={designPager.page}
                            pageCount={designPager.pageCount}
                            pageSize={designPager.pageSize}
                            pageSizeOptions={designPager.pageSizeOptions}
                            rangeLabel={designPager.rangeLabel}
                            onPageChange={designPager.setPage}
                            onPageSizeChange={designPager.setPageSize}
                            className="!mt-0 w-full justify-end pt-3"
                          />
                        </div>
                      </div>
                    </>
                  )}
                  </div>
                </>
              )}
            </section>
          </div>
        </section>
        ) : null}
      </div>
    </ModuleWorkspaceCard>
    {bulkEditOpen ? (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 p-4"
        role="dialog"
        aria-modal="true"
      >
        <div className="w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl">
          <div className="border-b border-zinc-100 px-5 py-4">
            <h3 className="text-lg font-semibold text-zinc-900">批量修改</h3>
            <p className="mt-1 text-xs text-zinc-500">
              将对已选择的 <strong>{selectedDesignIds.length}</strong> 条测试设计生效。
            </p>
          </div>
          <div className="space-y-3 px-5 py-4">
            <div>
              <label className="text-xs font-medium text-zinc-700">
                类别 / 目录（树状，可选）
              </label>
              <select
                className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={
                  bulkEditDirId && bulkEditDirId !== "__clear__"
                    ? `dir:${bulkEditDirId}`
                    : bulkEditType
                      ? `type:${bulkEditType}`
                      : ""
                }
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    setBulkEditType("");
                    setBulkEditDirId("");
                    return;
                  }
                  if (v.startsWith("type:")) {
                    setBulkEditType(v.slice("type:".length) as TestDesignType);
                    setBulkEditDirId("");
                    return;
                  }
                  if (v.startsWith("dir:")) {
                    const id = v.slice("dir:".length);
                    const dir = customDirs.find((d) => d.id === id) ?? null;
                    if (!dir) {
                      setBulkEditType("");
                      setBulkEditDirId("");
                      return;
                    }
                    setBulkEditType(dir.parentType);
                    setBulkEditDirId(id);
                    return;
                  }
                }}
              >
                <option value="">不修改</option>
                {bulkEditTreeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] leading-snug text-zinc-500">
                下拉里会显示当前迭代下所有目录子节点（缩进表示层级）。选择目录会自动设置其所属类别。
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-700">目录（可选）</label>
              <div className="mt-1 flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
                  onClick={() => setBulkEditDirId("__clear__")}
                  disabled={batchWorking}
                  title="清空这些设计的目录归属（dirId 置空）"
                >
                  清空目录
                </button>
                <span className="text-xs text-zinc-500">
                  当前：{bulkEditDirId === "__clear__" ? "将清空" : bulkEditDirId ? "已选择目录" : "不修改"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-4">
            <button
              type="button"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              onClick={() => setBulkEditOpen(false)}
              disabled={batchWorking}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              onClick={() => void runBatchEdit()}
              disabled={batchWorking}
            >
              {batchWorking ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    ) : null}
    {moveAllModalOpen ? (
      <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/45 p-4">
        <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
          <div className="shrink-0 border-b border-zinc-100 px-6 py-4">
            <h3 className="text-lg font-semibold text-zinc-900">整需求迁入</h3>
            <p className="mt-1 text-sm text-zinc-500">
              将<strong>源需求</strong>下全部测试设计迁入当前选中需求「{selectedReqTitle || selectedReqId}
              」；迁入后设计在目标需求下为<strong>根节点</strong>，迭代编码随目标需求。
            </p>
          </div>
          <div className="space-y-4 px-6 py-4">
            <div>
              <label className="text-sm font-medium text-zinc-700">源需求（当前迭代）</label>
              <select
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={moveAllSourceReqId}
                onChange={(e) => setMoveAllSourceReqId(e.target.value)}
              >
                {moveAllReqSelectOptions.length === 0 ? (
                  <option value="">无可选源需求（或仅有一个需求）</option>
                ) : (
                  moveAllReqSelectOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                onClick={() => setMoveAllModalOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                disabled={batchWorking || !moveAllSourceReqId}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                onClick={() => void confirmMoveAllFromRequirement()}
              >
                {batchWorking ? "处理中…" : "迁入"}
              </button>
            </div>
          </div>
        </div>
      </div>
    ) : null}
    {moveModalOpen ? (
      <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/45 p-4">
        <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
          <div className="shrink-0 border-b border-zinc-100 px-6 py-4">
            <h3 className="text-lg font-semibold text-zinc-900">批量移动</h3>
            <p className="mt-1 text-sm text-zinc-500">选择目标需求（会移动为根节点）。</p>
          </div>
          <div className="space-y-4 px-6 py-4">
            <div>
              <label className="text-sm font-medium text-zinc-700">目标迭代</label>
              <select
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={moveTargetIterationCode}
                onChange={(e) => setMoveTargetIterationCode(e.target.value)}
              >
                {visibleIterations.map((o) => (
                  <option key={o.code || "__all__"} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-zinc-700">目标需求</label>
              <select
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={moveTargetReqId}
                onChange={(e) => setMoveTargetReqId(e.target.value)}
              >
                {moveReqSelectOptions.map((o) => (
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
                onClick={confirmBatchMove}
              >
                移动
              </button>
            </div>
          </div>
        </div>
      </div>
    ) : null}

    {hideBlockedDialog ? (
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="td-delete-blocked-title"
        aria-describedby="td-delete-blocked-detail"
        onClick={() => setHideBlockedDialog(null)}
      >
        <div
          className="max-w-md rounded-xl border border-zinc-200 bg-white p-6 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2
            id="td-delete-blocked-title"
            className="text-lg font-semibold text-zinc-900"
          >
            {hideBlockedDialog.title}
          </h2>
          <p
            id="td-delete-blocked-detail"
            className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-zinc-600"
          >
            {hideBlockedDialog.detail}
          </p>
          <button
            type="button"
            className="mt-6 w-full rounded-lg bg-zinc-900 py-2.5 text-sm font-medium text-white hover:bg-zinc-800"
            onClick={() => setHideBlockedDialog(null)}
          >
            知道了
          </button>
        </div>
      </div>
    ) : null}

    {newCustomDirOpen ? (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="td-new-custom-dir-title"
        onClick={() => {
          setNewCustomDirOpen(false);
          setNewCustomDirName("");
        }}
      >
        <div
          className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2
            id="td-new-custom-dir-title"
            className="text-base font-semibold text-zinc-900"
          >
            新增自定义目录
          </h2>
          <label className="mt-3 block text-xs font-medium text-zinc-600">
            目录名称
          </label>
          <input
            ref={newCustomDirInputRef}
            className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            value={newCustomDirName}
            onChange={(e) => setNewCustomDirName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitNewCustomDir();
            }}
            placeholder="显示在「其他」下的自定义分组"
          />
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              onClick={() => {
                setNewCustomDirOpen(false);
                setNewCustomDirName("");
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white hover:bg-zinc-800"
              onClick={submitNewCustomDir}
            >
              确定
            </button>
          </div>
        </div>
      </div>
    ) : null}

    {restoreHiddenOpen ? (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/45 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="td-restore-hidden-title"
        onClick={() => setRestoreHiddenOpen(false)}
      >
        <div
          className="max-h-[min(80vh,28rem)] w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-b border-zinc-100 px-5 py-4">
            <h2
              id="td-restore-hidden-title"
              className="text-base font-semibold text-zinc-900"
            >
              恢复隐藏的目录
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              点击一项即可取消隐藏；与系统内置分类重名时请以列表为准。
            </p>
          </div>
          <div className="max-h-[min(52vh,20rem)] space-y-1 overflow-y-auto px-3 py-3">
            {hiddenCategoriesForRestore.map((h) => (
              <button
                key={h.key}
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-zinc-100 bg-zinc-50/80 px-3 py-2.5 text-left text-sm hover:bg-zinc-100"
                onClick={() => restoreHiddenCategory(h.key)}
              >
                <span className="font-medium text-zinc-800">{h.label}</span>
                <span className="text-xs text-zinc-500">系统分类</span>
              </button>
            ))}
            {hiddenCustomDirsForRestore.map((h) => (
              <button
                key={h.id}
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-zinc-100 bg-zinc-50/80 px-3 py-2.5 text-left text-sm hover:bg-zinc-100"
                onClick={() => restoreHiddenCustomDir(h.id)}
              >
                <span className="font-medium text-zinc-800">{h.label}</span>
                <span className="text-xs text-zinc-500">自定义</span>
              </button>
            ))}
          </div>
          <div className="border-t border-zinc-100 px-3 py-3">
            <button
              type="button"
              className="w-full rounded-lg border border-zinc-200 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
              onClick={() => setRestoreHiddenOpen(false)}
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function ReqTreeRows({
  node,
  depth,
  selectedId,
  onSelect,
  countByReqId,
  expandedById,
  onToggle,
}: {
  node: ReqNode;
  depth: number;
  selectedId: string;
  onSelect: (id: string) => void;
  countByReqId?: Record<string, number>;
  expandedById?: Record<string, boolean>;
  onToggle?: (id: string) => void;
}) {
  const expanded = expandedById?.[node.id] ?? true;
  const count =
    typeof countByReqId?.[node.id] === "number" ? countByReqId[node.id] : null;
  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selectedId === node.id}
      data-td-req-row={node.id}
    >
      <div
        className={[
          "group flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs leading-tight transition-colors",
          selectedId === node.id ? "bg-zinc-200/90" : "hover:bg-zinc-100/80",
        ].join(" ")}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          type="button"
          className={[
            "h-5 w-5 shrink-0 rounded text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-700",
            node.children.length > 0 ? "visible" : "invisible pointer-events-none",
          ].join(" ")}
          onClick={() => onToggle?.(node.id)}
          aria-label={expanded ? "收起" : "展开"}
          title={expanded ? "收起" : "展开"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className={[
            "min-w-0 flex-1 text-left",
            "block min-w-0",
          ].join(" ")}
          title={
            node.iterationLabel
              ? `${node.title} · ${node.iterationLabel}`
              : node.title
          }
        >
          <span className="block min-w-0 font-medium text-zinc-800">
            <span className="inline-flex min-w-0 items-center gap-1">
              <span className="min-w-0 truncate">{node.title}</span>
              {node.status === "PENDING_VERIFICATION" ? (
                <span
                  className="inline-flex h-4 shrink-0 items-center rounded-full border border-blue-300 bg-blue-50 px-1.5 text-[10px] font-semibold leading-none text-blue-700"
                  title="待验证"
                  aria-label="待验证"
                >
                  ✓
                </span>
              ) : null}
              {node.testOwner?.trim() ? (
                <span
                  className="inline-flex h-4 shrink-0 items-center rounded-full border border-zinc-200 bg-white px-1.5 text-[10px] font-medium leading-none text-zinc-700"
                  title={`测试负责人：${node.testOwner}`}
                  aria-label={`测试负责人：${node.testOwner}`}
                >
                  {node.testOwner}
                </span>
              ) : null}
              {count !== null ? (
                <span
                  className="shrink-0 rounded bg-zinc-200 px-1 py-0.5 text-[10px] leading-none tabular-nums text-zinc-700"
                  title={`已关联设计数：${count}（当前迭代下该需求的全部类别合计；右侧列表按「当前类别」筛选，条数可能更少）`}
                  aria-label={`已关联设计数：${count}`}
                >
                  {count}
                </span>
              ) : null}
            </span>
          </span>
        </button>
      </div>
      {node.children.length > 0 && expanded && (
        <div className="relative ml-2 border-l border-dashed border-zinc-200 pl-1 pt-0.5">
          <ul className="space-y-0.5" role="group">
            {node.children.map((c) => (
              <ReqTreeRows
                key={c.id}
                node={c}
                depth={depth + 1}
                selectedId={selectedId}
                onSelect={onSelect}
                countByReqId={countByReqId}
                expandedById={expandedById}
                onToggle={onToggle}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
