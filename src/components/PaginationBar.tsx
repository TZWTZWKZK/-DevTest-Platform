"use client";

import { useMemo } from "react";

export function PaginationBar({
  page,
  pageCount,
  pageSize,
  pageSizeOptions,
  rangeLabel,
  onPageChange,
  onPageSizeChange,
  className,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  pageSizeOptions: number[];
  rangeLabel: string;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
  /** 追加到外层容器，可用 `!mt-0` 覆盖默认上边距 */
  className?: string;
}) {
  const pages = useMemo(() => {
    // 简单分页：最多显示 7 个页码
    const max = 7;
    if (pageCount <= max) return Array.from({ length: pageCount }, (_, i) => i + 1);
    const out: number[] = [];
    const left = Math.max(1, page - 2);
    const right = Math.min(pageCount, page + 2);
    out.push(1);
    for (let p = left; p <= right; p++) {
      if (p !== 1 && p !== pageCount) out.push(p);
    }
    out.push(pageCount);
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }, [page, pageCount]);

  return (
    <div
      className={["mt-3 flex flex-wrap items-center justify-end gap-2 text-sm", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs text-zinc-500 tabular-nums">显示 {rangeLabel}</div>
        <label className="text-xs text-zinc-500">每页</label>
        <select
          className="rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
        >
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            上一页
          </button>
          {pages.map((p, idx) => {
            const prev = pages[idx - 1];
            const needDots = idx > 0 && prev !== undefined && p - prev > 1;
            return (
              <span key={p} className="flex items-center gap-1">
                {needDots ? <span className="px-1 text-xs text-zinc-400">…</span> : null}
                <button
                  type="button"
                  className={[
                    "rounded-md border px-2 py-1 text-xs",
                    p === page
                      ? "border-zinc-900 bg-zinc-900 text-white"
                      : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50",
                  ].join(" ")}
                  onClick={() => onPageChange(p)}
                >
                  {p}
                </button>
              </span>
            );
          })}
          <button
            type="button"
            className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 disabled:opacity-40"
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </div>
  );
}

