"use client";

import type { IterationAnalysisListRow } from "@/app/actions/iteration-analysis";
import { listIterationsByProduct } from "@/app/actions/iterations";
import type { ProductOption } from "@/app/actions/products";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import { formatIsoBeijing } from "@/lib/timezone-cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePagination } from "@/hooks/usePagination";

function buildListUrl(productId: string, iterationId: string) {
  const p = new URLSearchParams();
  if (productId) p.set("productId", productId);
  if (iterationId) p.set("iterationId", iterationId);
  const q = p.toString();
  return `/executions/iteration-analysis${q ? `?${q}` : ""}`;
}

function buildEditUrl(iterationId: string, productId: string) {
  const p = new URLSearchParams();
  p.set("edit", iterationId);
  if (productId) p.set("productId", productId);
  return `/executions/iteration-analysis?${p.toString()}`;
}

export function IterationAnalysisListClient({
  initialRows,
  products,
  initialProductId,
  initialIterationId,
}: {
  initialRows: IterationAnalysisListRow[];
  products: ProductOption[];
  initialProductId?: string;
  initialIterationId?: string;
}) {
  const router = useRouter();
  const [productId, setProductId] = useState(initialProductId?.trim() ?? "");
  const [iterationId, setIterationId] = useState(
    initialIterationId?.trim() ?? "",
  );
  const [iterationOptions, setIterationOptions] = useState<
    { id: string; label: string }[]
  >([]);
  const [iterLoading, setIterLoading] = useState(false);

  useEffect(() => {
    const pid = initialProductId?.trim() ?? "";
    const iid = initialIterationId?.trim() ?? "";
    setProductId(pid);
    setIterationId(iid);
  }, [initialProductId, initialIterationId]);

  useEffect(() => {
    if (!productId) {
      setIterationOptions([]);
      return;
    }
    let cancelled = false;
    setIterLoading(true);
    void listIterationsByProduct(productId).then((rows) => {
      if (cancelled) return;
      setIterationOptions(
        rows.map((r) => ({
          id: r.id,
          label: `${r.name}（${r.code}）`,
        })),
      );
      setIterLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const applyFilters = useCallback(
    (pid: string, iid: string) => {
      router.push(buildListUrl(pid, iid));
    },
    [router],
  );

  const filteredRows = useMemo(() => initialRows, [initialRows]);

  const pager = usePagination(filteredRows, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.iterationAnalysisList",
  });

  return (
    <ModuleWorkspaceCard>
      <div className="border-b border-zinc-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <span className="shrink-0">产品</span>
            <select
              className="min-w-[180px] rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm shadow-sm"
              value={productId}
              onChange={(e) => {
                const v = e.target.value;
                setProductId(v);
                setIterationId("");
                applyFilters(v, "");
              }}
            >
              <option value="">全部产品</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.code ? `（${p.code}）` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <span className="shrink-0">迭代</span>
            <select
              className="min-w-[220px] rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm shadow-sm disabled:opacity-50"
              value={iterationId}
              disabled={!productId || iterLoading}
              onChange={(e) => {
                const v = e.target.value;
                setIterationId(v);
                applyFilters(productId, v);
              }}
            >
              <option value="">
                {productId ? "全部迭代" : "请先选择产品"}
              </option>
              {iterationOptions.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.label}
                </option>
              ))}
            </select>
          </label>
          {iterationId ? (
            <Link
              href={buildEditUrl(iterationId, productId)}
              className={MODULE_TOOLBAR_BTN_PRIMARY}
            >
              编辑分析
            </Link>
          ) : (
            <span
              className={`${MODULE_TOOLBAR_BTN_PRIMARY} pointer-events-none opacity-40`}
              title="请先选择具体迭代"
            >
              编辑分析
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-zinc-600">
              <th className="px-4 py-2.5 font-medium">迭代</th>
              <th className="px-4 py-2.5 font-medium">产品</th>
              <th className="px-4 py-2.5 font-medium">创建人</th>
              <th className="px-4 py-2.5 font-medium">修改人</th>
              <th className="px-4 py-2.5 font-medium">创建时间</th>
              <th className="px-4 py-2.5 font-medium">修改时间</th>
            </tr>
          </thead>
          <tbody>
            {pager.pagedItems.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-zinc-500"
                >
                  暂无匹配的迭代记录
                </td>
              </tr>
            ) : (
              pager.pagedItems.map((row) => (
                <tr
                  key={row.iterationId}
                  role="link"
                  tabIndex={0}
                  className="cursor-pointer border-b border-zinc-100 hover:bg-zinc-50/80"
                  onClick={() =>
                    router.push(buildEditUrl(row.iterationId, row.productId))
                  }
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    router.push(buildEditUrl(row.iterationId, row.productId));
                  }}
                >
                  <td className="px-4 py-2.5 text-zinc-900">
                    {row.iterationName}
                    <span className="ml-1 text-xs text-zinc-400">
                      {row.iterationCode}
                    </span>
                    {!row.hasReport ? (
                      <span className="ml-2 text-xs text-amber-600">
                        未填写
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-700">
                    {row.productName}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600">
                    {row.createdBy || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-600">
                    {row.updatedBy || "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                    {row.createdAt
                      ? formatIsoBeijing(row.createdAt, { withSeconds: true })
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-zinc-600">
                    {row.updatedAt
                      ? formatIsoBeijing(row.updatedAt, { withSeconds: true })
                      : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <PaginationBar
        page={pager.page}
        pageCount={pager.pageCount}
        pageSize={pager.pageSize}
        pageSizeOptions={pager.pageSizeOptions}
        rangeLabel={pager.rangeLabel}
        onPageChange={pager.setPage}
        onPageSizeChange={pager.setPageSize}
      />
    </ModuleWorkspaceCard>
  );
}
