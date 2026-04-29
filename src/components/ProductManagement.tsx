"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createProduct, deleteProduct, updateProduct } from "@/app/actions/products";
import { PaginationBar } from "@/components/PaginationBar";
import { usePagination } from "@/hooks/usePagination";

export type PrimaryProjectOption = {
  id: string;
  name: string;
  code: string | null;
};

export type ProductRow = {
  id: string;
  name: string;
  code: string | null;
  level: number;
  parentId: string | null;
  parentLabel: string | null;
  owner: string | null;
  department: string | null;
  teamMembers: string | null;
  startDate: string | null;
  endDate: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  iterationCount: number;
};

function formatDateTime(iso: string) {
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

function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function truncate(s: string | null, max: number) {
  if (!s) return "—";
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function splitNameWithParenCode(label: string | null): { name: string; code: string | null } {
  const s = (label ?? "").trim();
  if (!s) return { name: "—", code: null };
  const m = s.match(/^(.*)（(.+)）$/);
  if (!m) return { name: s, code: null };
  return { name: (m[1] ?? "").trim() || "—", code: (m[2] ?? "").trim() || null };
}

export function ProductManagement({
  initialProducts,
  primaryProjectOptions,
}: {
  initialProducts: ProductRow[];
  primaryProjectOptions: PrimaryProjectOption[];
}) {
  const router = useRouter();
  const [products, setProducts] = useState(initialProducts);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [deleteBusyId, setDeleteBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [levelDraft, setLevelDraft] = useState(1);

  useEffect(() => {
    setProducts(initialProducts);
  }, [initialProducts]);

  const prodPager = usePagination(products, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.products",
  });

  const parentChoices = useMemo(() => {
    const selfId = editing?.id;
    return primaryProjectOptions.filter((p) => p.id !== selfId);
  }, [primaryProjectOptions, editing?.id]);

  async function onDelete(id: string, name: string) {
    if (!window.confirm(`确定删除产品「${name}」？其下迭代将一并删除。`)) {
      return;
    }
    setDeleteBusyId(id);
    setActionError(null);
    const res = await deleteProduct(id);
    setDeleteBusyId(null);
    if (res?.error) {
      setActionError(res.error);
      return;
    }
    setProducts((prev) => prev.filter((p) => p.id !== id));
    router.refresh();
  }

  async function onSubmitCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setFormBusy(true);
    setActionError(null);
    const res = await createProduct(null, fd);
    setFormBusy(false);
    if (res?.error) {
      setActionError(res.error);
      return;
    }
    router.refresh();
    setModalMode(null);
    form.reset();
    setLevelDraft(1);
  }

  async function onSubmitEdit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setFormBusy(true);
    setActionError(null);
    const res = await updateProduct(null, fd);
    setFormBusy(false);
    if (res?.error) {
      setActionError(res.error);
      return;
    }
    router.refresh();
    setModalMode(null);
    setEditing(null);
  }

  const inputClass =
    "mt-1.5 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none ring-zinc-950/10 transition focus:border-zinc-900 focus:ring-2";
  const labelClass = "block text-sm font-medium text-zinc-700";

  return (
    <div className="p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-200 pb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
              产品管理
            </h1>
            <p className="mt-1 text-sm text-zinc-500">
              维护产品（项目）主数据：项目名称、编码、层级、关联一级项目、负责人与周期等。
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setEditing(null);
              setModalMode("create");
              setLevelDraft(1);
            }}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800"
          >
            新增产品
          </button>
        </header>

        {actionError && (
          <div
            className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            role="alert"
          >
            {actionError}
          </div>
        )}

        <div className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead className="border-b border-zinc-200 bg-zinc-50 text-xs font-medium text-zinc-500">
                <tr>
                  <th className="whitespace-nowrap px-3 py-3">项目名称</th>
                  <th className="whitespace-nowrap px-3 py-3">项目编码</th>
                  <th className="whitespace-nowrap px-3 py-3">项目层级</th>
                  <th className="whitespace-nowrap px-3 py-3">关联一级项目</th>
                  <th className="whitespace-nowrap px-3 py-3">项目负责人</th>
                  <th className="whitespace-nowrap px-3 py-3">归属部门</th>
                  <th className="min-w-[140px] px-3 py-3">项目团队成员</th>
                  <th className="whitespace-nowrap px-3 py-3">开始时间</th>
                  <th className="whitespace-nowrap px-3 py-3">结束时间</th>
                  <th className="whitespace-nowrap px-3 py-3">迭代数</th>
                  <th className="whitespace-nowrap px-3 py-3">更新时间</th>
                  <th className="whitespace-nowrap px-3 py-3 text-right">
                    操作
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {products.length === 0 ? (
                  <tr>
                    <td
                      colSpan={12}
                      className="px-4 py-12 text-center text-zinc-500"
                    >
                      暂无产品，请点击「新增产品」创建第一条记录。
                    </td>
                  </tr>
                ) : (
                  prodPager.pagedItems.map((p) => (
                    <tr key={p.id} className="hover:bg-zinc-50/80">
                      <td className="whitespace-nowrap px-3 py-3 font-medium text-zinc-900">
                        {p.name}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-zinc-500 tabular-nums">
                        {p.code ?? (
                          <span className="text-amber-700">待补全</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500 tabular-nums">
                        {p.level}
                      </td>
                      <td className="max-w-[200px] truncate px-3 py-3 text-zinc-600">
                        {(() => {
                          const { name, code } = splitNameWithParenCode(p.parentLabel);
                          return (
                            <span className="inline-flex min-w-0 items-baseline gap-1">
                              <span className="truncate">{name}</span>
                              {code ? (
                                <span className="shrink-0 font-mono text-[11px] text-zinc-400 tabular-nums">
                                  （{code}）
                                </span>
                              ) : null}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-zinc-600">
                        {p.owner ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-zinc-600">
                        {p.department ?? "—"}
                      </td>
                      <td
                        className="max-w-[200px] px-3 py-3 text-zinc-600"
                        title={p.teamMembers ?? undefined}
                      >
                        {truncate(p.teamMembers, 24)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500 tabular-nums">
                        {toDateInputValue(p.startDate) || "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500 tabular-nums">
                        {toDateInputValue(p.endDate) || "—"}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500 tabular-nums">
                        {p.iterationCount}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500 tabular-nums">
                        {formatDateTime(p.updatedAt)}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setActionError(null);
                              setEditing(p);
                              setModalMode("edit");
                              setLevelDraft(p.level);
                            }}
                            className="rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={deleteBusyId === p.id}
                            onClick={() => onDelete(p.id, p.name)}
                            className="rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            {deleteBusyId === p.id ? "删除中…" : "删除"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="px-4 pb-4">
            <PaginationBar
              page={prodPager.page}
              pageCount={prodPager.pageCount}
              pageSize={prodPager.pageSize}
              pageSizeOptions={prodPager.pageSizeOptions}
              rangeLabel={prodPager.rangeLabel}
              onPageChange={prodPager.setPage}
              onPageSizeChange={prodPager.setPageSize}
            />
          </div>
        </div>
      </div>

      {modalMode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="product-modal-title"
          onClick={() => {
            if (formBusy) return;
            setModalMode(null);
            setEditing(null);
            setActionError(null);
          }}
        >
          <div
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="product-modal-title"
              className="text-lg font-semibold text-zinc-900"
            >
              {modalMode === "create" ? "新增产品" : "编辑产品"}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              项目名称与项目编码必填；项目层级大于 1 时必须选择关联一级项目。
            </p>

            <form
              key={modalMode === "create" ? "create" : editing?.id ?? "edit"}
              className="mt-5 space-y-4"
              onSubmit={modalMode === "create" ? onSubmitCreate : onSubmitEdit}
            >
              {modalMode === "edit" && editing && (
                <input type="hidden" name="id" value={editing.id} />
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="project-name" className={labelClass}>
                    项目名称
                  </label>
                  <input
                    id="project-name"
                    name="name"
                    required
                    defaultValue={editing?.name ?? ""}
                    className={inputClass}
                    placeholder="例如：订单中心改造"
                    disabled={formBusy}
                    autoComplete="off"
                  />
                </div>

                <div>
                  <label htmlFor="project-code" className={labelClass}>
                    项目编码
                  </label>
                  <input
                    id="project-code"
                    name="code"
                    required
                    defaultValue={editing?.code ?? ""}
                    className={inputClass}
                    placeholder="唯一编码，如 PRJ-ORD-01"
                    disabled={formBusy}
                    autoComplete="off"
                  />
                </div>

                <div>
                  <label htmlFor="project-level" className={labelClass}>
                    项目层级
                  </label>
                  <input
                    id="project-level"
                    name="level"
                    type="number"
                    min={1}
                    max={99}
                    defaultValue={editing?.level ?? 1}
                    onChange={(e) => {
                      const v = Number.parseInt(e.target.value, 10);
                      setLevelDraft(
                        Number.isNaN(v) ? 1 : Math.max(1, Math.min(99, v)),
                      );
                    }}
                    className={inputClass}
                    disabled={formBusy}
                  />
                  <p className="mt-1 text-xs text-zinc-500">
                    填 1 表示一级项目；大于 1 时需选择下方「关联一级项目」。
                  </p>
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="project-parent" className={labelClass}>
                    关联一级项目
                  </label>
                  <select
                    id="project-parent"
                    name="parentId"
                    className={inputClass}
                    disabled={formBusy || levelDraft === 1}
                    defaultValue={editing?.parentId ?? ""}
                  >
                    <option value="">
                      {levelDraft === 1 ? "一级项目无需关联" : "请选择一级项目"}
                    </option>
                    {parentChoices.map((opt) => (
                      <option key={opt.id} value={opt.id}>
                        {opt.name}（{opt.code ?? "无编码"}）
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="project-owner" className={labelClass}>
                    项目负责人
                  </label>
                  <input
                    id="project-owner"
                    name="owner"
                    defaultValue={editing?.owner ?? ""}
                    className={inputClass}
                    placeholder="可选"
                    disabled={formBusy}
                    autoComplete="off"
                  />
                </div>

                <div>
                  <label htmlFor="project-dept" className={labelClass}>
                    归属部门
                  </label>
                  <input
                    id="project-dept"
                    name="department"
                    defaultValue={editing?.department ?? ""}
                    className={inputClass}
                    placeholder="可选"
                    disabled={formBusy}
                    autoComplete="off"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="project-team" className={labelClass}>
                    项目团队成员
                  </label>
                  <textarea
                    id="project-team"
                    name="teamMembers"
                    rows={3}
                    defaultValue={editing?.teamMembers ?? ""}
                    className={inputClass + " resize-y"}
                    placeholder="可多行填写姓名，或用顿号、逗号分隔"
                    disabled={formBusy}
                  />
                </div>

                <div>
                  <label htmlFor="project-start" className={labelClass}>
                    开始时间
                  </label>
                  <input
                    id="project-start"
                    name="startDate"
                    type="date"
                    defaultValue={toDateInputValue(editing?.startDate)}
                    className={inputClass}
                    disabled={formBusy}
                  />
                </div>

                <div>
                  <label htmlFor="project-end" className={labelClass}>
                    结束时间
                  </label>
                  <input
                    id="project-end"
                    name="endDate"
                    type="date"
                    defaultValue={toDateInputValue(editing?.endDate)}
                    className={inputClass}
                    disabled={formBusy}
                  />
                </div>

                <div className="sm:col-span-2">
                  <label htmlFor="project-desc" className={labelClass}>
                    备注说明
                  </label>
                  <textarea
                    id="project-desc"
                    name="description"
                    rows={2}
                    defaultValue={editing?.description ?? ""}
                    className={inputClass + " resize-y"}
                    placeholder="可选"
                    disabled={formBusy}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4">
                <button
                  type="button"
                  disabled={formBusy}
                  onClick={() => {
                    setModalMode(null);
                    setEditing(null);
                    setActionError(null);
                  }}
                  className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={formBusy}
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                >
                  {formBusy ? "提交中…" : modalMode === "create" ? "创建" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
