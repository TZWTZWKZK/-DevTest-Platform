"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteIteration,
  getIterationOpLogs,
  listIterationsByProduct,
  saveIteration,
  type IterationOpLogRow,
  type IterationStatus,
  type IterationRow,
  type ProductOption,
} from "@/app/actions/iterations";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import {
  ITERATION_COLUMN_LABELS,
  useIterationListColumns,
  type IterationColumnKey,
} from "@/hooks/useIterationListColumns";
import { usePagination } from "@/hooks/usePagination";

const iterationStatusLabel: Record<IterationStatus, string> = {
  IN_PROGRESS: "进行中",
  OVERDUE: "逾期",
  COMPLETED: "完成",
};

const iterationStatusBadgeClass: Record<IterationStatus, string> = {
  IN_PROGRESS: "border-amber-500/80 bg-amber-50 text-amber-900",
  OVERDUE: "border-red-500/80 bg-red-50 text-red-800",
  COMPLETED: "border-emerald-500/80 bg-emerald-50 text-emerald-800",
};

const ITER_ACTIONS_COL_W = 144;

function formatIterOpTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function isoToDateValue(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

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

function iterRowDateKey(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function inDayRange(
  day: string,
  from: string,
  to: string,
): boolean {
  if (!from && !to) return true;
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function inDateTimeRange(
  iso: string,
  from: string,
  to: string,
): boolean {
  if (!from && !to) return true;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (from) {
    const f = new Date(from + "T00:00:00").getTime();
    if (t < f) return false;
  }
  if (to) {
    const e = new Date(to + "T23:59:59.999").getTime();
    if (t > e) return false;
  }
  return true;
}

function resolveInitialProductId(
  products: ProductOption[],
  urlProductId?: string,
): string {
  const u = urlProductId?.trim();
  if (u && products.some((p) => p.id === u)) return u;
  return products[0]?.id ?? "";
}

export function IterationManagementClient({
  initialProducts,
  initialProductId,
  initialIterationId,
}: {
  initialProducts: ProductOption[];
  /** 来自查询串，与迭代列表所属产品一致时选中该产品（非默认第一项） */
  initialProductId?: string;
  /** 来自查询串，列表加载后将翻页并滚动到该迭代行 */
  initialIterationId?: string;
}) {
  const [productId, setProductId] = useState(() =>
    resolveInitialProductId(initialProducts, initialProductId),
  );
  /** 仅当 URL 带有 productId 时同步（无查询参数时不覆盖用户在下拉框中的选择） */
  useEffect(() => {
    const u = initialProductId?.trim();
    if (!u) return;
    const resolved = resolveInitialProductId(initialProducts, u);
    if (!resolved) return;
    setProductId((prev) => (prev === resolved ? prev : resolved));
  }, [initialProductId, initialProducts]);
  const [rows, setRows] = useState<IterationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<IterationRow | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [status, setStatus] = useState<IterationStatus>("IN_PROGRESS");
  const [submitter, setSubmitter] = useState("");

  const {
    config: iterColConfig,
    visibleOrdered: iterVisibleOrdered,
    setVisible: setIterColVisible,
    moveKey: moveIterCol,
    setWidth: setIterColWidth,
    widthFor: iterWidthFor,
    resetDefaults: resetIterCols,
  } = useIterationListColumns();

  const [iterModalTab, setIterModalTab] = useState<"detail" | "ops">("detail");
  const [iterationOpLogs, setIterationOpLogs] = useState<IterationOpLogRow[]>(
    [],
  );

  const [iterAdvOpen, setIterAdvOpen] = useState(false);
  const [iterGearOpen, setIterGearOpen] = useState(false);
  const [iterAdv, setIterAdv] = useState({
    status: "" as IterationStatus | "",
    nameContains: "",
    contentContains: "",
    codeContains: "",
    submitterContains: "",
    startDateFrom: "",
    startDateTo: "",
    endDateFrom: "",
    endDateTo: "",
    createdFrom: "",
    createdTo: "",
    updatedFrom: "",
    updatedTo: "",
  });
  const startResizeCol = useCallback(
    (e: React.MouseEvent, key: IterationColumnKey) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = iterWidthFor(key);
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        setIterColWidth(key, startW + dx);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [iterWidthFor, setIterColWidth],
  );

  const iterTableMinW = useMemo(() => {
    const sum = iterVisibleOrdered.reduce((a, k) => a + iterWidthFor(k), 0);
    return sum + ITER_ACTIONS_COL_W + 24;
  }, [iterVisibleOrdered, iterWidthFor]);

  const displayRows = useMemo(() => {
    let list = rows;
    if (iterAdv.status) {
      list = list.filter((r) => r.status === iterAdv.status);
    }
    const nc = iterAdv.nameContains.trim().toLowerCase();
    if (nc) {
      list = list.filter((r) => r.name.toLowerCase().includes(nc));
    }
    const cc = iterAdv.contentContains.trim().toLowerCase();
    if (cc) {
      list = list.filter((r) =>
        (r.content ?? "").toLowerCase().includes(cc),
      );
    }
    const codeC = iterAdv.codeContains.trim().toLowerCase();
    if (codeC) {
      list = list.filter((r) => r.code.toLowerCase().includes(codeC));
    }
    const sc = iterAdv.submitterContains.trim().toLowerCase();
    if (sc) {
      list = list.filter((r) =>
        (r.submitter ?? "").toLowerCase().includes(sc),
      );
    }
    const { startDateFrom, startDateTo, endDateFrom, endDateTo } = iterAdv;
    if (startDateFrom || startDateTo) {
      list = list.filter((r) =>
        inDayRange(iterRowDateKey(r.startDate), startDateFrom, startDateTo),
      );
    }
    if (endDateFrom || endDateTo) {
      list = list.filter((r) =>
        inDayRange(iterRowDateKey(r.endDate), endDateFrom, endDateTo),
      );
    }
    const { createdFrom, createdTo, updatedFrom, updatedTo } = iterAdv;
    if (createdFrom || createdTo) {
      list = list.filter((r) =>
        inDateTimeRange(r.createdAt, createdFrom, createdTo),
      );
    }
    if (updatedFrom || updatedTo) {
      list = list.filter((r) =>
        inDateTimeRange(r.updatedAt, updatedFrom, updatedTo),
      );
    }
    return list;
  }, [rows, iterAdv]);

  const iterPager = usePagination(displayRows, { defaultPageSize: 20 });
  const iterationFocusAppliedRef = useRef(false);
  const iterationFocusKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const k = `${initialProductId?.trim() ?? ""}:${initialIterationId?.trim() ?? ""}`;
    if (iterationFocusKeyRef.current !== k) {
      iterationFocusKeyRef.current = k;
      iterationFocusAppliedRef.current = false;
    }
  }, [initialProductId, initialIterationId]);

  useEffect(() => {
    if (iterationFocusAppliedRef.current) return;
    const fid = initialIterationId?.trim();
    if (!fid) return;
    if (loading || displayRows.length === 0) return;
    const idx = displayRows.findIndex((r) => r.id === fid);
    if (idx < 0) {
      iterationFocusAppliedRef.current = true;
      return;
    }
    iterationFocusAppliedRef.current = true;
    const ps = iterPager.pageSize;
    iterPager.setPage(Math.floor(idx / ps) + 1);
    const t = window.setTimeout(() => {
      document
        .getElementById(`iteration-row-${fid}`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(t);
  }, [
    loading,
    displayRows,
    initialIterationId,
    iterPager.pageSize,
    iterPager.setPage,
  ]);

  const openCreate = () => {
    if (!productId) {
      setNotice("请先选择产品");
      return;
    }
    setIterModalTab("detail");
    setIterationOpLogs([]);
    setEditing(null);
    setName("");
    setContent("");
    setStartDate("");
    setEndDate("");
    setStatus("IN_PROGRESS");
    setSubmitter("");
    setModalOpen(true);
  };

  const openEdit = (r: IterationRow) => {
    setIterModalTab("detail");
    setEditing(r);
    setName(r.name);
    setContent(r.content ?? "");
    setStartDate(isoToDateValue(r.startDate));
    setEndDate(isoToDateValue(r.endDate));
    setStatus(r.status);
    setSubmitter(r.submitter ?? "");
    setModalOpen(true);
  };

  const reload = useCallback(async () => {
    if (!productId) {
      setRows([]);
      return;
    }
    setLoading(true);
    try {
      const list = await listIterationsByProduct(productId);
      setRows(list);
    } catch {
      setRows([]);
      setNotice("加载迭代列表失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!modalOpen) return;
    if (!editing?.id) {
      setIterationOpLogs([]);
      return;
    }
    let cancelled = false;
    void getIterationOpLogs(editing.id, 50).then((rows) => {
      if (!cancelled) setIterationOpLogs(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [modalOpen, editing?.id]);

  const submit = async () => {
    if (!productId) return;
    setSaving(true);
    setNotice(null);
    try {
      const r = await saveIteration({
        id: editing?.id,
        productId,
        name,
        content: content.trim() || null,
        startDate: startDate || null,
        endDate: endDate || null,
        status,
        submitter: submitter.trim() || null,
      });
      if (r.error) {
        setNotice(r.error);
        return;
      }
      setModalOpen(false);
      setIterModalTab("detail");
      setIterationOpLogs([]);
      reload();
    } catch {
      setNotice("保存失败（网络异常或服务错误），请稍后重试。");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`确定删除迭代「${label}」？`)) return;
    setNotice(null);
    const r = await deleteIteration(id);
    if (r.error) {
      setNotice(r.error);
      return;
    }
    reload();
  };

  const productLabel = useMemo(() => {
    return initialProducts.find((p) => p.id === productId)?.label ?? "";
  }, [initialProducts, productId]);

  return (
    <ModuleWorkspaceCard>
      <div className="flex min-h-[70vh] flex-col">
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
                {initialProducts.length === 0 ? (
                  <option value="">暂无产品，请先在「产品管理」创建</option>
                ) : (
                  initialProducts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))
                )}
              </select>
            </div>
            <p className="hidden max-w-xl pb-0.5 text-[11px] leading-snug text-zinc-500 sm:block">
              创建迭代前先选择产品；切换产品仅展示该产品下的迭代数据。
            </p>
          </div>
        </div>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
          <div className="border-b border-zinc-100 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">
                  迭代列表{productLabel ? `：${productLabel}` : ""}
                </h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  字段包含：名称/编码/内容/开始结束时间/状态/提交人/创建时间/更新时间。
                </p>
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setIterAdvOpen((o) => !o)}
                  className={MODULE_TOOLBAR_BTN_SECONDARY}
                  aria-expanded={iterAdvOpen}
                >
                  <span>高级筛选</span>{" "}
                  <span className="ml-1 text-xs text-zinc-500">
                    {iterAdvOpen ? "▼" : "▶"}
                  </span>
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIterGearOpen((o) => !o)}
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    title="列表列设置（显隐、顺序；表头可拖竖线调宽）"
                    aria-expanded={iterGearOpen}
                    aria-haspopup="true"
                    aria-label="迭代列表列设置"
                  >
                    ⚙
                  </button>
                  {iterGearOpen ? (
                    <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-[320px] rounded-xl border border-zinc-200 bg-white p-2 shadow-xl">
                      <div className="px-2 pb-2 text-xs font-medium text-zinc-500">
                        列设置
                      </div>
                      <div className="max-h-[320px] overflow-auto">
                        {iterColConfig.order.map((k, idx) => (
                          <div
                            key={k}
                            className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-zinc-300"
                              checked={iterColConfig.visible[k] !== false}
                              onChange={(e) =>
                                setIterColVisible(k, e.target.checked)
                              }
                            />
                            <div className="flex-1 text-sm text-zinc-800">
                              {ITERATION_COLUMN_LABELS[k]}
                            </div>
                            <button
                              type="button"
                              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                              disabled={idx === 0}
                              onClick={() => moveIterCol(k, -1)}
                              title="上移"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                              disabled={
                                idx === iterColConfig.order.length - 1
                              }
                              onClick={() => moveIterCol(k, 1)}
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
                          onClick={() => resetIterCols()}
                        >
                          重置默认
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white"
                          onClick={() => setIterGearOpen(false)}
                        >
                          关闭
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={openCreate}
                  disabled={!productId}
                  className={MODULE_TOOLBAR_BTN_PRIMARY}
                >
                  + 新建迭代
                </button>
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 p-4">
            {notice && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {notice}
              </div>
            )}
            {iterAdvOpen ? (
              <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50/60 px-3 py-3">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      状态
                    </label>
                    <select
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.status}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          status: e.target.value as IterationStatus | "",
                        }))
                      }
                    >
                      <option value="">全部</option>
                      {(Object.keys(iterationStatusLabel) as IterationStatus[]).map(
                        (s) => (
                          <option key={s} value={s}>
                            {iterationStatusLabel[s]}
                          </option>
                        ),
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      迭代名称包含
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.nameContains}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          nameContains: e.target.value,
                        }))
                      }
                      placeholder="模糊匹配"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      迭代内容包含
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.contentContains}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          contentContains: e.target.value,
                        }))
                      }
                      placeholder="模糊匹配"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      迭代编码包含
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.codeContains}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          codeContains: e.target.value,
                        }))
                      }
                      placeholder="模糊匹配"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      提交人包含
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.submitterContains}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          submitterContains: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      开始日期从
                    </label>
                    <input
                      type="date"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.startDateFrom}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          startDateFrom: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      开始日期到
                    </label>
                    <input
                      type="date"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.startDateTo}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          startDateTo: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      结束日期从
                    </label>
                    <input
                      type="date"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.endDateFrom}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          endDateFrom: e.target.value,
                        }))
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      结束日期到
                    </label>
                    <input
                      type="date"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                      value={iterAdv.endDateTo}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          endDateTo: e.target.value,
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
                      value={iterAdv.createdFrom}
                      onChange={(e) =>
                        setIterAdv((p) => ({
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
                      value={iterAdv.createdTo}
                      onChange={(e) =>
                        setIterAdv((p) => ({
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
                      value={iterAdv.updatedFrom}
                      onChange={(e) =>
                        setIterAdv((p) => ({
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
                      value={iterAdv.updatedTo}
                      onChange={(e) =>
                        setIterAdv((p) => ({
                          ...p,
                          updatedTo: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                    onClick={() =>
                      setIterAdv({
                        status: "",
                        nameContains: "",
                        contentContains: "",
                        codeContains: "",
                        submitterContains: "",
                        startDateFrom: "",
                        startDateTo: "",
                        endDateFrom: "",
                        endDateTo: "",
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
            ) : null}

            {!productId ? (
              <p className="text-sm text-zinc-500">请先选择产品。</p>
            ) : loading ? (
              <p className="text-sm text-zinc-500">加载中…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-zinc-500">当前产品下暂无迭代。</p>
            ) : displayRows.length === 0 ? (
              <p className="text-sm text-zinc-500">
                没有符合当前筛选条件的迭代，可尝试重置高级筛选。
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                <table
                  className="table-fixed text-left text-sm"
                  style={{ minWidth: iterTableMinW }}
                >
                  <thead className="border-b border-zinc-200 bg-zinc-50/80 text-xs text-zinc-500">
                    <tr>
                      {iterVisibleOrdered.map((k, idx) => {
                        const w = iterWidthFor(k);
                        return (
                          <th
                            key={k}
                            className={[
                              "relative select-none py-2.5 align-bottom font-medium",
                              idx === 0 ? "pl-3 pr-2" : "pr-2",
                            ].join(" ")}
                            style={{ width: w, minWidth: w }}
                          >
                            <span className="block truncate">
                              {ITERATION_COLUMN_LABELS[k]}
                            </span>
                            <span
                              className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-zinc-300/40"
                              role="separator"
                              title="拖动调整列宽"
                              onMouseDown={(e) => startResizeCol(e, k)}
                            />
                          </th>
                        );
                      })}
                      <th
                        className="py-2.5 pr-3 text-right align-bottom font-medium"
                        style={{
                          width: ITER_ACTIONS_COL_W,
                          minWidth: ITER_ACTIONS_COL_W,
                        }}
                      >
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {iterPager.pagedItems.map((r) => {
                      const focusRow =
                        initialIterationId?.trim() === r.id;
                      return (
                      <tr
                        key={r.id}
                        id={`iteration-row-${r.id}`}
                        className={[
                          "hover:bg-zinc-50/80",
                          focusRow
                            ? "bg-sky-50/90 ring-1 ring-inset ring-sky-200"
                            : "",
                        ].join(" ")}
                      >
                        {iterVisibleOrdered.map((k, colIdx) => {
                          const w = iterWidthFor(k);
                          const padFirst =
                            colIdx === 0 ? "pl-3 pr-2" : "pr-2";
                          switch (k) {
                            case "name":
                              return (
                                <td
                                  key={k}
                                  role="button"
                                  tabIndex={0}
                                  title="点击编辑"
                                  className={`max-w-0 cursor-pointer overflow-hidden py-2.5 ${padFirst}`}
                                  style={{ width: w, minWidth: w }}
                                  onClick={() => openEdit(r)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      openEdit(r);
                                    }
                                  }}
                                >
                                  <div className="truncate font-medium text-zinc-900">
                                    {r.name}
                                  </div>
                                  {r.content ? (
                                    <div className="mt-0.5 line-clamp-2 text-xs text-zinc-500">
                                      {r.content}
                                    </div>
                                  ) : null}
                                </td>
                              );
                            case "code":
                              return (
                                <td
                                  key={k}
                                  role="button"
                                  tabIndex={0}
                                  title="点击编辑"
                                  className={`max-w-0 cursor-pointer overflow-hidden py-2.5 font-mono text-xs italic text-zinc-500 tabular-nums ${padFirst}`}
                                  style={{ width: w, minWidth: w }}
                                  onClick={() => openEdit(r)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      openEdit(r);
                                    }
                                  }}
                                >
                                  <span className="block truncate">
                                    {r.code}
                                  </span>
                                </td>
                              );
                            case "startDate":
                              return (
                                <td
                                  key={k}
                                  className={`max-w-0 truncate py-2.5 text-zinc-600 tabular-nums ${padFirst}`}
                                  style={{ width: w, minWidth: w }}
                                >
                                  {r.startDate
                                    ? isoToDateValue(r.startDate)
                                    : "—"}
                                </td>
                              );
                            case "endDate":
                              return (
                                <td
                                  key={k}
                                  className={`max-w-0 truncate py-2.5 text-zinc-600 tabular-nums ${padFirst}`}
                                  style={{ width: w, minWidth: w }}
                                >
                                  {r.endDate
                                    ? isoToDateValue(r.endDate)
                                    : "—"}
                                </td>
                              );
                            case "status":
                              return (
                                <td
                                  key={k}
                                  className={`py-2.5 ${padFirst}`}
                                  style={{ width: w, minWidth: w }}
                                >
                                  <span
                                    className={[
                                      "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                                      iterationStatusBadgeClass[r.status],
                                    ].join(" ")}
                                  >
                                    <span className="truncate">
                                      {iterationStatusLabel[r.status]}
                                    </span>
                                  </span>
                                </td>
                              );
                            case "submitter":
                              return (
                                <td
                                  key={k}
                                  className={`max-w-0 truncate py-2.5 text-zinc-600 ${padFirst}`}
                                  style={{ width: w, minWidth: w }}
                                >
                                  {r.submitter ?? "—"}
                                </td>
                              );
                            case "createdAt":
                              return (
                                <td
                                  key={k}
                                  className={`max-w-0 truncate py-2.5 text-zinc-600 tabular-nums ${padFirst}`}
                                  style={{ width: w, minWidth: w }}
                                >
                                  {formatTs(r.createdAt)}
                                </td>
                              );
                            case "updatedAt":
                              return (
                                <td
                                  key={k}
                                  className={`max-w-0 truncate py-2.5 text-zinc-600 tabular-nums ${padFirst}`}
                                  style={{ width: w, minWidth: w }}
                                >
                                  {formatTs(r.updatedAt)}
                                </td>
                              );
                            default:
                              return null;
                          }
                        })}
                        <td
                          className="py-2.5 pr-3 text-right"
                          style={{
                            width: ITER_ACTIONS_COL_W,
                            minWidth: ITER_ACTIONS_COL_W,
                          }}
                        >
                          <div className="inline-flex gap-2">
                            <button
                              type="button"
                              className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50"
                              onClick={() => openEdit(r)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className="rounded border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                              onClick={() => remove(r.id, r.name)}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                    })}
                  </tbody>
                </table>
                <div className="px-3 pb-3">
                  <PaginationBar
                    page={iterPager.page}
                    pageCount={iterPager.pageCount}
                    pageSize={iterPager.pageSize}
                    pageSizeOptions={iterPager.pageSizeOptions}
                    rangeLabel={iterPager.rangeLabel}
                    onPageChange={iterPager.setPage}
                    onPageSizeChange={iterPager.setPageSize}
                  />
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal
        >
          <div className="w-full max-w-4xl rounded-2xl border border-zinc-200 bg-white shadow-xl">
            <div className="border-b border-zinc-100 px-6 py-4">
              <h3 className="text-lg font-semibold text-zinc-900">
                {editing ? "编辑迭代" : "新建迭代"}
              </h3>
              <div className="mt-2 max-w-[820px]">
                <input
                  className="w-full rounded-lg border border-transparent bg-transparent px-0 py-0 text-lg font-semibold text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-transparent focus:ring-0"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="迭代名称"
                />
                <div className="mt-1 text-xs text-zinc-500">
                  {editing ? (
                    <>迭代编码：{editing.code}</>
                  ) : (
                    <>迭代编码将在保存后由系统自动生成</>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3">
                  <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs">
                    <button
                      type="button"
                      aria-selected={iterModalTab === "detail"}
                      className={[
                        "rounded-md px-2.5 py-1 font-medium",
                        iterModalTab === "detail"
                          ? "bg-zinc-900 text-white"
                          : "text-zinc-700 hover:bg-zinc-50",
                      ].join(" ")}
                      onClick={() => setIterModalTab("detail")}
                    >
                      迭代详情
                    </button>
                    <button
                      type="button"
                      aria-selected={iterModalTab === "ops"}
                      className={[
                        "rounded-md px-2.5 py-1 font-medium",
                        iterModalTab === "ops"
                          ? "bg-zinc-900 text-white"
                          : "text-zinc-700 hover:bg-zinc-50",
                      ].join(" ")}
                      onClick={() => setIterModalTab("ops")}
                    >
                      操作记录
                    </button>
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    {iterModalTab === "detail"
                      ? "填写内容与周期后保存。"
                      : editing
                        ? `最近 ${iterationOpLogs.length} 条`
                        : "保存并生成编码后，再次打开编辑可查看记录。"}
                  </div>
                </div>
              </div>
            </div>
            <div className="max-h-[min(72vh,680px)] min-h-0 overflow-y-auto px-6 py-4">
              {iterModalTab === "detail" ? (
                <>
                  <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
                <section className="rounded-xl border border-zinc-200 bg-zinc-50/40 p-4">
                  <label className="text-xs font-medium text-zinc-600">
                    迭代内容
                  </label>
                  <textarea
                    className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                    rows={12}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="迭代的说明、范围、目标等"
                  />
                </section>
                <section className="rounded-xl border border-transparent bg-transparent p-0">
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        开始时间
                      </label>
                      <input
                        type="date"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        结束时间
                      </label>
                      <input
                        type="date"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        状态
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={status}
                        onChange={(e) =>
                          setStatus(e.target.value as IterationStatus)
                        }
                      >
                        {Object.entries(iterationStatusLabel).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        提交人
                      </label>
                      <input
                        className="mt-1 w-full cursor-not-allowed rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-600"
                        value={submitter}
                        disabled
                        title="提交人默认不可修改"
                      />
                    </div>
                  </div>
                </section>
                  </div>
                  {notice ? (
                    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      {notice}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="rounded-lg border border-zinc-200 bg-white">
                  <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600">
                    操作记录（最近 {iterationOpLogs.length} 条）
                  </div>
                  <div className="max-h-[min(60vh,520px)] overflow-auto">
                    {!editing?.id ? (
                      <div className="px-3 py-3 text-sm text-zinc-500">
                        新建迭代保存后，可在此查看新建与后续更新记录。
                      </div>
                    ) : iterationOpLogs.length === 0 ? (
                      <div className="px-3 py-3 text-sm text-zinc-500">暂无记录。</div>
                    ) : (
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-zinc-50 text-xs text-zinc-500">
                          <tr>
                            <th className="w-40 px-3 py-2 text-left">时间</th>
                            <th className="w-40 px-3 py-2 text-left">动作</th>
                            <th className="px-3 py-2 text-left">说明</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                          {iterationOpLogs.map((x) => (
                            <tr key={x.id} className="hover:bg-zinc-50/70">
                              <td className="px-3 py-2 align-top text-xs text-zinc-600 tabular-nums">
                                {formatIterOpTs(x.createdAt)}
                              </td>
                              <td className="px-3 py-2 align-top font-mono text-[11px] text-zinc-600">
                                {x.action}
                              </td>
                              <td className="max-w-0 px-3 py-2 align-top whitespace-pre-wrap break-words text-xs text-zinc-700">
                                {x.detail ?? "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="border-t border-zinc-100 px-6 py-4">
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                  onClick={() => setModalOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={saving}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                  onClick={submit}
                >
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </ModuleWorkspaceCard>
  );
}

