"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeColumnOrder } from "@/lib/normalize-column-order";

export const EXEC_IMPORTED_CASE_COLUMN_KEYS = [
  "caseNo",
  "title",
  "status",
  "priority",
  "maintainer",
  "submitter",
  "updatedAt",
  "createdAt",
  "ops",
] as const;

export type ExecImportedCaseColumnKey =
  (typeof EXEC_IMPORTED_CASE_COLUMN_KEYS)[number];

export const EXEC_IMPORTED_CASE_COLUMN_LABELS: Record<
  ExecImportedCaseColumnKey,
  string
> = {
  caseNo: "用例编号",
  title: "用例名称",
  status: "状态",
  priority: "用例等级",
  maintainer: "维护人",
  submitter: "提交人",
  updatedAt: "更新时间",
  createdAt: "创建时间",
  ops: "移除",
};

const DEFAULT_WIDTH: Record<ExecImportedCaseColumnKey, number> = {
  caseNo: 120,
  title: 220,
  status: 120,
  priority: 88,
  maintainer: 88,
  submitter: 88,
  updatedAt: 156,
  createdAt: 156,
  ops: 64,
};

const DEFAULT_ORDER: ExecImportedCaseColumnKey[] = [
  ...EXEC_IMPORTED_CASE_COLUMN_KEYS,
];

const DEFAULT_VISIBLE: Record<ExecImportedCaseColumnKey, boolean> = {
  caseNo: true,
  title: true,
  status: true,
  priority: true,
  maintainer: true,
  submitter: true,
  updatedAt: true,
  createdAt: true,
  ops: true,
};

export type ExecImportedCaseColumnConfig = {
  order: ExecImportedCaseColumnKey[];
  visible: Record<ExecImportedCaseColumnKey, boolean>;
  widths: Partial<Record<ExecImportedCaseColumnKey, number>>;
};

function normalizeKey(key: string): ExecImportedCaseColumnKey | null {
  const k = key as ExecImportedCaseColumnKey;
  return EXEC_IMPORTED_CASE_COLUMN_KEYS.includes(k) ? k : null;
}

export function useExecutionImportedCaseColumns() {
  const [config, setConfig] = useState<ExecImportedCaseColumnConfig>(() => ({
    order: DEFAULT_ORDER,
    visible: { ...DEFAULT_VISIBLE },
    widths: {},
  }));
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
  }, []);

  const visibleOrdered = useMemo(
    () => config.order.filter((k) => config.visible[k] !== false),
    [config.order, config.visible],
  );

  const widthFor = useCallback(
    (k: ExecImportedCaseColumnKey) => config.widths[k] ?? DEFAULT_WIDTH[k],
    [config.widths],
  );

  const setVisible = useCallback((k: ExecImportedCaseColumnKey, show: boolean) => {
    setConfig((prev) => ({
      ...prev,
      visible: { ...prev.visible, [k]: show },
    }));
  }, []);

  const moveKey = useCallback((k: ExecImportedCaseColumnKey, delta: -1 | 1) => {
    setConfig((prev) => {
      const idx = prev.order.indexOf(k);
      if (idx < 0) return prev;
      const next = [...prev.order];
      const j = idx + delta;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return { ...prev, order: next };
    });
  }, []);

  const setWidth = useCallback((k: ExecImportedCaseColumnKey, w: number) => {
    const width = Math.max(48, Math.min(720, Math.round(w)));
    setConfig((prev) => ({
      ...prev,
      widths: { ...prev.widths, [k]: width },
    }));
  }, []);

  const resetDefaults = useCallback(() => {
    setConfig({
      order: normalizeColumnOrder([], DEFAULT_ORDER),
      visible: { ...DEFAULT_VISIBLE },
      widths: {},
    });
  }, []);

  /** 从服务端 JSON 合并进 state */
  const mergeFromServer = useCallback((raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const cfg = raw as Partial<{
      order: string[];
      visible: Record<string, boolean>;
      widths: Record<string, number>;
    }>;
    const order = Array.isArray(cfg.order)
      ? cfg.order.map(normalizeKey).filter((k): k is ExecImportedCaseColumnKey => k !== null)
      : [];
    setConfig({
      order: normalizeColumnOrder(order, DEFAULT_ORDER),
      visible:
        cfg.visible && typeof cfg.visible === "object"
          ? { ...DEFAULT_VISIBLE, ...(cfg.visible as Record<ExecImportedCaseColumnKey, boolean>) }
          : { ...DEFAULT_VISIBLE },
      widths:
        cfg.widths && typeof cfg.widths === "object"
          ? (cfg.widths as Partial<Record<ExecImportedCaseColumnKey, number>>)
          : {},
    });
  }, []);

  return {
    config,
    setConfig,
    mergeFromServer,
    visibleOrdered,
    setVisible,
    moveKey,
    setWidth,
    widthFor,
    resetDefaults,
    defaultConfig: {
      order: DEFAULT_ORDER,
      visible: { ...DEFAULT_VISIBLE },
      widths: {},
    },
    labels: EXEC_IMPORTED_CASE_COLUMN_LABELS,
  };
}
