"use client";

import { useEffect, useMemo, useState } from "react";

export type PaginationState = {
  page: number; // 1-based
  pageSize: number;
};

export function usePagination<T>(
  items: T[],
  opts?: {
    defaultPageSize?: number;
    pageSizeOptions?: number[];
  },
) {
  const pageSizeOptions = opts?.pageSizeOptions ?? [10, 20, 50, 100];
  const defaultPageSize = opts?.defaultPageSize ?? 20;

  const [pageSize, setPageSize] = useState<number>(
    pageSizeOptions.includes(defaultPageSize) ? defaultPageSize : 20,
  );
  const [page, setPage] = useState<number>(1);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    // items 或 pageSize 变化时，保证 page 不越界
    setPage((p) => Math.min(Math.max(1, p), pageCount));
  }, [pageCount]);

  const pagedItems = useMemo(() => {
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  const rangeLabel = useMemo(() => {
    if (total === 0) return "0 / 0";
    const start = (page - 1) * pageSize + 1;
    const end = Math.min(total, page * pageSize);
    return `${start}-${end} / ${total}`;
  }, [page, pageSize, total]);

  return {
    page,
    setPage,
    pageSize,
    setPageSize: (n: number) => {
      const next = pageSizeOptions.includes(n) ? n : 20;
      setPageSize(next);
      setPage(1);
    },
    pageSizeOptions,
    total,
    pageCount,
    rangeLabel,
    pagedItems,
  };
}

