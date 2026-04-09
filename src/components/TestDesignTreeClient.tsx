"use client";

import type React from "react";
import type { TestDesignType } from "@prisma/client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bulkDeleteTestDesignNodes,
  bulkMoveTestDesignNodes,
  countTestDesignsForCategoryHide,
  countTestDesignsForCustomDirHide,
  createTestDesignNode,
  countTestDesignByRequirement,
  countTestDesignByType,
  deleteTestDesignNode,
  getTestDesignFlat,
  getTestDesignsExportRows,
  listRequirementsForDesignTree,
  type RequirementTreeFlat,
  type TestDesignFlat,
} from "@/app/actions/test-design";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import {
  TEST_DESIGN_COLUMN_LABELS,
  useTestDesignListColumns,
  type TestDesignColumnKey,
} from "@/hooks/useTestDesignListColumns";
import { usePagination } from "@/hooks/usePagination";
import { testDesignTypeLabel, testDesignTypeOptions } from "@/lib/test-labels";
import { buildTree, type TreeNode } from "@/lib/tree";

const PENDING_TEST_DESIGN_IMPORT_STORAGE = "pm-pending-test-design-import";

type Node = TreeNode<TestDesignFlat>;
type ReqNode = TreeNode<RequirementTreeFlat>;

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

type CategoryItem = {
  key: TestDesignType;
  label: string;
  hidden?: boolean;
};

const CATEGORY_STORAGE_KEY = "pm-test-design-categories-v1";
const CUSTOM_DIR_STORAGE_KEY = "pm-test-design-custom-dirs-v1";

type CustomDir = { id: string; label: string; hidden?: boolean };

function loadCustomDirs(): CustomDir[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CUSTOM_DIR_STORAGE_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as unknown;
    if (!Array.isArray(j)) return [];
    const out: CustomDir[] = [];
    for (const it of j) {
      if (!it || typeof it !== "object") continue;
      const rec = it as unknown as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : "";
      const label = typeof rec.label === "string" ? rec.label : "";
      const hidden = Boolean(rec.hidden);
      if (!id || !label.trim()) continue;
      out.push({ id, label: label.trim(), hidden });
    }
    return out;
  } catch {
    return [];
  }
}

function saveCustomDirs(list: CustomDir[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(CUSTOM_DIR_STORAGE_KEY, JSON.stringify(list));
}

function dirTag(label: string): string {
  return `【${label}】`;
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
  customDirLabel,
  onAdded,
}: {
  nodes: Node[];
  depth: number;
  requirementId: string;
  iterationCode: string;
  customDirLabel: string | null;
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
      title:
        customDirLabel && (parentType ?? "FUNCTIONAL") === "OTHER"
          ? `${dirTag(customDirLabel)} ${titleDraft}`.trim()
          : titleDraft,
      type: parentType ?? ("FUNCTIONAL" as TestDesignType),
      iterationCode,
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
              {customDirLabel && n.type === "OTHER"
                ? stripDirTag(n.title) || n.title
                : n.title}
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
              customDirLabel={customDirLabel}
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
}: {
  iterations: { code: string; label: string }[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlNavOnceRef = useRef(false);
  const urlPendingRequirementIdRef = useRef<string | null>(null);
  const [iterationCode, setIterationCode] = useState<string>("");
  const [topPaneH, setTopPaneH] = useState(138);
  const [reqFlat, setReqFlat] = useState<RequirementTreeFlat[]>([]);
  const [selectedReqId, setSelectedReqId] = useState<string>("");
  const [flat, setFlat] = useState<TestDesignFlat[]>([]);
  const [loading, setLoading] = useState(false);
  const [rootErr, setRootErr] = useState<string | null>(null);
  const [rootTitle, setRootTitle] = useState("");
  const [rootBusy, setRootBusy] = useState(false);
  const [category, setCategory] = useState<TestDesignType>("FUNCTIONAL");
  const [categoryEditOpen, setCategoryEditOpen] = useState(false);
  const [categories, setCategories] = useState<CategoryItem[]>(() =>
    defaultCategoriesForHydration(),
  );
  const [customDirs, setCustomDirs] = useState<CustomDir[]>([]);
  const [selectedCustomDirId, setSelectedCustomDirId] = useState<string | null>(
    null,
  );
  const [reqSearch, setReqSearch] = useState("");
  const [designSearch, setDesignSearch] = useState("");
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
  const [reqDesignCounts, setReqDesignCounts] = useState<Record<string, number>>(
    {},
  );
  const [expandedReq, setExpandedReq] = useState<Record<string, boolean>>({});

  const [selectedDesignIds, setSelectedDesignIds] = useState<string[]>([]);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const [batchWorking, setBatchWorking] = useState(false);
  const [moveModalOpen, setMoveModalOpen] = useState(false);
  const [moveTargetReqId, setMoveTargetReqId] = useState<string>("");
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
  });

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
  const skipFirstCustomDirsPersist = useRef(true);

  useEffect(() => {
    setCategories(loadCategories());
    setCustomDirs(loadCustomDirs());
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
    return sum + 40 + 24;
  }, [designVisibleOrdered, designWidthFor]);

  useEffect(() => {
    if (skipFirstCategoriesPersist.current) {
      skipFirstCategoriesPersist.current = false;
      return;
    }
    saveCategories(categories);
  }, [categories]);
  useEffect(() => {
    if (skipFirstCustomDirsPersist.current) {
      skipFirstCustomDirsPersist.current = false;
      return;
    }
    saveCustomDirs(customDirs);
  }, [customDirs]);

  const visibleCategories = useMemo(
    () => categories.filter((c) => !c.hidden),
    [categories],
  );
  const visibleCustomDirs = useMemo(
    () => customDirs.filter((d) => !d.hidden),
    [customDirs],
  );
  const hiddenCategoriesForRestore = useMemo(
    () => categories.filter((c) => c.hidden),
    [categories],
  );
  const hiddenCustomDirsForRestore = useMemo(
    () => customDirs.filter((d) => d.hidden),
    [customDirs],
  );
  const activeCustomDirLabel = useMemo(() => {
    if (!selectedCustomDirId) return null;
    return visibleCustomDirs.find((d) => d.id === selectedCustomDirId)?.label ?? null;
  }, [selectedCustomDirId, visibleCustomDirs]);

  useEffect(() => {
    if (!visibleCategories.some((c) => c.key === category)) {
      setCategory(visibleCategories[0]?.key ?? ("FUNCTIONAL" as TestDesignType));
    }
  }, [category, visibleCategories]);

  useEffect(() => {
    // 非 OTHER 时不使用自定义目录
    if (category !== "OTHER") setSelectedCustomDirId(null);
  }, [category]);

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
    const id = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setCustomDirs((prev) => [...prev, { id, label: name, hidden: false }]);
    setNewCustomDirOpen(false);
    setNewCustomDirName("");
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
    setCustomDirs((prev) =>
      prev.map((x) => (x.id === id ? { ...x, hidden: false } : x)),
    );
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
      const r = await countTestDesignsForCustomDirHide({
        customDirLabel: label,
        iterationCode,
      });
      if ("error" in r) {
        setHideBlockedDialog({
          title: "不可删除",
          detail: `校验时出错，暂时不能从侧栏删除自定义目录「${label}」。\n\n原因：${r.error}`,
        });
        return;
      }
      if (r.count > 0) {
        const scope = iterationCode.trim()
          ? "当前迭代筛选下"
          : "全部迭代范围内";
        setHideBlockedDialog({
          title: "不可删除",
          detail: `「${label}」目录下仍有关联的测试设计（「其他」类且标题以「【${label}】」开头）。\n\n原因：${scope}仍有 ${r.count} 条。请先迁移、删除或改标题后再从侧栏删除该目录。`,
        });
        return;
      }
      if (
        !window.confirm(
          `确定从侧栏删除自定义目录「${label}」？仅移除侧栏入口，数据仍保留；可在「恢复隐藏」中找回。`,
        )
      ) {
        return;
      }
      setCustomDirs((prev) =>
        prev.map((x) => (x.id === id ? { ...x, hidden: true } : x)),
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
    const data = await getTestDesignFlat({
      requirementId: selectedReqId,
      iterationCode: iterationCode === "" ? "" : iterationCode,
      type: category,
    });
    setFlat(data);
    setLoading(false);
  }, [category, iterationCode, selectedReqId]);

  const startResizeTopPane = useCallback(
    (startX: number, startY: number) => {
      const sy = startY;
      const h0 = topPaneH;
      const move = (ev: globalThis.MouseEvent) => {
        const dy = ev.clientY - sy;
        setTopPaneH(Math.min(360, Math.max(96, h0 + dy)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [topPaneH],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (urlNavOnceRef.current) return;
    const ic = searchParams.get("iterationCode")?.trim() ?? "";
    const rq = searchParams.get("requirementId")?.trim() ?? "";
    if (!ic && !rq) return;
    urlNavOnceRef.current = true;
    if (rq) urlPendingRequirementIdRef.current = rq;
    if (ic && iterations.some((it) => it.code === ic)) {
      setIterationCode(ic);
    }
    router.replace("/test-design", { scroll: false });
  }, [searchParams, iterations, router]);

  useEffect(() => {
    (async () => {
      const rows = await listRequirementsForDesignTree(iterationCode);
      setReqFlat(rows);
      const pending = urlPendingRequirementIdRef.current;
      if (pending && rows.some((r) => r.id === pending)) {
        setSelectedReqId(pending);
        urlPendingRequirementIdRef.current = null;
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
  }, [iterationCode]);

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
      setReqDesignCounts(m);
    })();
  }, [iterationCode, reqFlat]);

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
        return;
      }
      const code = iterationCode === "" ? "" : iterationCode;
      const counts = await countTestDesignByType({
        requirementId: selectedReqId,
        iterationCode: code,
      });
      setCountsByType(counts);
      if (code === "") {
        setOtherFlatAll([]);
        return;
      }
      const other = await getTestDesignFlat({
        requirementId: selectedReqId,
        iterationCode: code,
        type: "OTHER",
      });
      setOtherFlatAll(other);
    })();
  }, [iterationCode, selectedReqId]);

  const filteredReqFlat = useMemo(() => {
    if (!reqSearch.trim()) return reqFlat;
    return filterTreeKeepAncestors(reqFlat, (r) => matchesText(r.title, reqSearch));
  }, [reqFlat, reqSearch]);
  const reqTree = useMemo(() => buildTree(filteredReqFlat), [filteredReqFlat]);

  const filteredDesignFlat = useMemo(() => {
    if (!designSearch.trim()) return flat;
    return filterTreeKeepAncestors(flat, (r) => matchesText(r.title, designSearch));
  }, [designSearch, flat]);
  const filteredByCustomDir = useMemo(() => {
    if (category !== "OTHER" || !activeCustomDirLabel) return filteredDesignFlat;
    const tag = dirTag(activeCustomDirLabel);
    return filteredDesignFlat.filter((r) => r.title.startsWith(tag));
  }, [activeCustomDirLabel, category, filteredDesignFlat]);

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
        return true;
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [adv, filteredByCustomDir]);

  const designPager = usePagination(listRows, { defaultPageSize: 20 });
  const pagedDesignRows = designPager.pagedItems;

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

  const runBatchDelete = useCallback(async () => {
    if (selectedDesignIds.length === 0) return;
    if (!window.confirm(`确定批量删除已选 ${selectedDesignIds.length} 条设计？`)) return;
    setBatchWorking(true);
    const r = await bulkDeleteTestDesignNodes(selectedDesignIds);
    setBatchWorking(false);
    if (r.error) return;
    setSelectedDesignIds([]);
    reload();
  }, [reload, selectedDesignIds]);

  const runBatchMove = useCallback(async () => {
    if (selectedDesignIds.length === 0) return;
    setMoveTargetReqId(selectedReqId);
    setMoveModalOpen(true);
  }, [selectedDesignIds.length, selectedReqId]);

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
    reload();
  }, [moveTargetReqId, reload, selectedDesignIds]);

  const runBatchImport = useCallback(() => {
    if (selectedDesignIds.length === 0) return;
    try {
      sessionStorage.setItem(
        PENDING_TEST_DESIGN_IMPORT_STORAGE,
        JSON.stringify({ ids: selectedDesignIds, ts: Date.now() }),
      );
    } catch {
      /* ignore */
    }
    router.push("/test-cases?designImport=1");
  }, [router, selectedDesignIds]);

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
  const reqById = useMemo(() => new Map(reqFlat.map((r) => [r.id, r])), [reqFlat]);
  const selectedReqTitle = selectedReqId ? reqById.get(selectedReqId)?.title : "";

  const addRoot = async () => {
    if (!selectedReqId) return;
    setRootBusy(true);
    setRootErr(null);
    const r = await createTestDesignNode({
      requirementId: selectedReqId,
      parentId: null,
      title:
        category === "OTHER" && activeCustomDirLabel
          ? `${dirTag(activeCustomDirLabel)} ${rootTitle}`.trim()
          : rootTitle,
      type: category,
      iterationCode: iterationCode === "" ? "" : iterationCode,
    });
    setRootBusy(false);
    if (r.error) {
      setRootErr(r.error);
      return;
    }
    setRootTitle("");
    reload();
  };

  return (
    <>
    <ModuleWorkspaceCard>
      <div className="flex min-h-[70vh] flex-col">
        <div
          className="relative shrink-0 overflow-hidden border-b border-zinc-200 bg-zinc-50/60 px-3 py-2 sm:px-4"
          style={{ height: topPaneH, minHeight: 96 }}
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
                迭代筛选
              </label>
              <select
                className="mt-0.5 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm"
                value={iterationCode}
                onChange={(e) => setIterationCode(e.target.value)}
                title="baseline 表示查看全部迭代"
              >
                {iterations.map((o) => (
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
          <div className="mt-2 max-h-36 min-h-0 overflow-y-auto rounded-md border border-zinc-200/90 bg-white/90 px-2 py-1.5">
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
          <div
            className="absolute bottom-0 left-0 right-0 z-20 h-2 cursor-row-resize hover:bg-zinc-300/30"
            role="separator"
            aria-label="拖动调整顶部区域高度"
            title="拖动调整高度"
            onMouseDown={(e) => {
              e.preventDefault();
              startResizeTopPane(e.clientX, e.clientY);
            }}
          />
        </div>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <section
              className="relative flex min-h-[180px] flex-col border-b border-zinc-200 bg-zinc-50/60 lg:min-h-0 lg:border-b-0 lg:border-r lg:border-zinc-200"
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
                      <div
                        className={[
                          "flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
                          category === o.key
                            ? "bg-zinc-200/90 text-zinc-900"
                            : "hover:bg-zinc-100/80 text-zinc-700",
                        ].join(" ")}
                      >
                        <button
                          type="button"
                          onClick={() => setCategory(o.key)}
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
                              onClick={() => {
                                const next = window.prompt("重命名类别", o.label);
                                if (!next || !next.trim()) return;
                                setCategories((prev) =>
                                  prev.map((x) =>
                                    x.key === o.key ? { ...x, label: next.trim() } : x,
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
                    </li>
                  ))}
                </ul>
                {visibleCustomDirs.map((d) => (
                  <ul key={d.id} className="space-y-0.5">
                    <li>
                      <div
                        className={[
                          "flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
                          category === "OTHER" && selectedCustomDirId === d.id
                            ? "bg-zinc-200/90 text-zinc-900"
                            : "hover:bg-zinc-100/80 text-zinc-700",
                        ].join(" ")}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setCategory("OTHER");
                            setSelectedCustomDirId(d.id);
                          }}
                          className="min-w-0 flex-1 truncate text-left font-medium"
                          title={d.label}
                        >
                          {d.label}
                        </button>
                        <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
                          {otherFlatAll.filter((r) =>
                            r.title.startsWith(dirTag(d.label)),
                          ).length}
                        </span>
                        {categoryEditOpen ? (
                          <>
                            <button
                              type="button"
                              className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-xs text-zinc-700 hover:bg-zinc-50"
                              onClick={() => {
                                const next = window.prompt("重命名目录", d.label);
                                if (!next || !next.trim()) return;
                                setCustomDirs((prev) =>
                                  prev.map((x) =>
                                    x.id === d.id
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
                              title="从侧栏删除该目录：存在归属该目录的设计时不可删除"
                              onClick={() => void confirmHideCustomDir(d.id, d.label)}
                            >
                              删
                            </button>
                          </>
                        ) : null}
                      </div>
                    </li>
                  </ul>
                ))}
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

            <section className="min-w-0 flex-1 bg-white p-4">
              {!selectedReqId ? (
                <p className="text-sm text-zinc-500">请先在上方选择需求节点。</p>
              ) : (
                <>
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
                    </div>
                    <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
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
                                    className="h-4 w-4 rounded border-zinc-300"
                                    checked={designColConfig.visible[k] !== false}
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
                    <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50/60">
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
                              })
                            }
                          >
                            重置筛选
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {loading ? (
                    <p className="text-sm text-zinc-500">加载中…</p>
                  ) : listRows.length === 0 ? (
                    <p className="text-sm text-zinc-500">
                      {iterationCode === ""
                        ? "baseline 数据已清空。"
                        : "暂无数据或不符合筛选条件。"}
                    </p>
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
                            onClick={runBatchMove}
                          >
                            批量移动
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

                      <div className="flex flex-col">
                        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                          <table
                            className="table-fixed text-left text-sm"
                            style={{ minWidth: designTableMinW }}
                          >
                          <thead className="border-b border-zinc-200 bg-zinc-50/80 text-xs text-zinc-500">
                            <tr>
                              <th className="w-10 py-2.5 pr-2 text-left align-bottom font-medium">
                                <input
                                  ref={selectAllRef}
                                  type="checkbox"
                                  className="h-4 w-4 rounded border-zinc-300"
                                  onChange={() => {
                                    const all = pagedDesignRows.map((r) => r.id);
                                    const set = new Set(selectedDesignIds);
                                    const allSelected =
                                      all.length > 0 &&
                                      all.every((id) => set.has(id));
                                    setSelectedDesignIds((prev) =>
                                      allSelected
                                        ? prev.filter((id) => !set.has(id))
                                        : Array.from(new Set([...prev, ...all])),
                                    );
                                  }}
                                />
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
                                    <span className="block truncate">
                                      {TEST_DESIGN_COLUMN_LABELS[k]}
                                    </span>
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
                          <tbody>
                            {pagedDesignRows.map((r) => (
                              <tr
                                key={r.id}
                                className="group cursor-pointer border-b border-zinc-100 hover:bg-zinc-50/70"
                                onClick={() => router.push(`/test-design/node/${r.id}`)}
                              >
                                <td className="w-10 py-2.5 pr-2 align-top">
                                  <input
                                    type="checkbox"
                                    className="mt-1 h-4 w-4 rounded border-zinc-300"
                                    checked={selectedDesignIds.includes(r.id)}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      setSelectedDesignIds((prev) =>
                                        prev.includes(r.id)
                                          ? prev.filter((x) => x !== r.id)
                                          : [...prev, r.id],
                                      );
                                    }}
                                    onClick={(e) => e.stopPropagation()}
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
                            ))}
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
                </>
              )}
            </section>
          </div>
        </section>
      </div>
    </ModuleWorkspaceCard>
    {moveModalOpen ? (
      <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/45 p-4">
        <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl">
          <div className="shrink-0 border-b border-zinc-100 px-6 py-4">
            <h3 className="text-lg font-semibold text-zinc-900">批量移动</h3>
            <p className="mt-1 text-sm text-zinc-500">选择目标需求（会移动为根节点）。</p>
          </div>
          <div className="space-y-4 px-6 py-4">
            <div>
              <label className="text-sm font-medium text-zinc-700">目标需求</label>
              <select
                className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                value={moveTargetReqId}
                onChange={(e) => setMoveTargetReqId(e.target.value)}
              >
                {reqFlat.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
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
  return (
    <li
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selectedId === node.id}
    >
      <div
        className={[
          "group flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-sm transition-colors",
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
            typeof countByReqId?.[node.id] === "number"
              ? "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-0.5"
              : "block min-w-0",
          ].join(" ")}
          title={
            node.iterationLabel
              ? `${node.title} · ${node.iterationLabel}`
              : node.title
          }
        >
          {typeof countByReqId?.[node.id] === "number" ? (
            <>
              <span className="min-w-0 truncate font-medium text-zinc-800">
                {node.title}
              </span>
              <span className="shrink-0 rounded bg-zinc-200 px-1 py-0.5 text-[10px] leading-none tabular-nums text-zinc-700">
                {countByReqId[node.id]}
              </span>
            </>
          ) : (
            <span className="block min-w-0 truncate font-medium text-zinc-800">
              {node.title}
            </span>
          )}
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
