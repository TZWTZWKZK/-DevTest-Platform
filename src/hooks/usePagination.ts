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
    /** 若提供则将 pageSize 持久化到 localStorage（仅客户端生效） */
    storageKey?: string;
  },
) {
  const pageSizeOptions = opts?.pageSizeOptions ?? [10, 20, 50, 100];
  const defaultPageSize = opts?.defaultPageSize ?? 20;
  const storageKey = opts?.storageKey?.trim() || "";

  const [pageSize, setPageSize] = useState<number>(() => {
    const fallback = pageSizeOptions.includes(defaultPageSize) ? defaultPageSize : 20;
    if (!storageKey) return fallback;
    try {
      const raw = localStorage.getItem(storageKey);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && pageSizeOptions.includes(n)) return n;
    } catch {
      // ignore
    }
    return fallback;
  });
  const [page, setPage] = useState<number>(1);

  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    // items 或 pageSize 变化时，保证 page 不越界
    setPage((p) => Math.min(Math.max(1, p), pageCount));
  }, [pageCount]);

  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(pageSize));
    } catch {
      // ignore
    }
  }, [pageSize, storageKey]);

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

