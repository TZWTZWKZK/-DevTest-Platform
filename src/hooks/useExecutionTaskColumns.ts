"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeColumnOrder } from "@/lib/normalize-column-order";

export const EXEC_TASK_COLUMN_KEYS = [
  "title",
  "linkedCaseCount",
  "passRate",
  "createdBy",
  "updatedBy",
  "updatedAt",
] as const;

export type ExecTaskColumnKey = (typeof EXEC_TASK_COLUMN_KEYS)[number];

export const EXEC_TASK_COLUMN_LABELS: Record<ExecTaskColumnKey, string> = {
  title: "任务名称",
  linkedCaseCount: "执行情况",
  passRate: "通过率",
  createdBy: "创建人",
  updatedBy: "修改人",
  updatedAt: "更新时间",
};

const DEFAULT_WIDTH: Record<ExecTaskColumnKey, number> = {
  title: 360,
  linkedCaseCount: 140,
  passRate: 140,
  createdBy: 112,
  updatedBy: 112,
  updatedAt: 180,
};

const DEFAULT_ORDER: ExecTaskColumnKey[] = [...EXEC_TASK_COLUMN_KEYS];

const DEFAULT_VISIBLE: Record<ExecTaskColumnKey, boolean> = {
  title: true,
  linkedCaseCount: true,
  passRate: true,
  createdBy: true,
  updatedBy: true,
  updatedAt: true,
};

export type ExecTaskColumnConfig = {
  order: ExecTaskColumnKey[];
  visible: Record<ExecTaskColumnKey, boolean>;
  widths: Partial<Record<ExecTaskColumnKey, number>>;
};

function normalizeKey(key: string): ExecTaskColumnKey | null {
  const k = key as ExecTaskColumnKey;
  return EXEC_TASK_COLUMN_KEYS.includes(k) ? k : null;
}

function parseStored(): ExecTaskColumnConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = null;
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<
      ExecTaskColumnConfig & {
        order?: string[];
        visible?: Record<string, boolean>;
        widths?: Record<string, number>;
      }
    >;
    const order = Array.isArray(j.order)
      ? j.order.map(normalizeKey).filter((k): k is ExecTaskColumnKey => k !== null)
      : [];
    const fullOrder = normalizeColumnOrder(order, DEFAULT_ORDER);
    const visible: Record<ExecTaskColumnKey, boolean> = { ...DEFAULT_VISIBLE };
    if (j.visible && typeof j.visible === "object") {
      for (const [key, val] of Object.entries(j.visible)) {
        const nk = normalizeKey(key);
        if (nk !== null && typeof val === "boolean") visible[nk] = val;
      }
    }
    const widths: Partial<Record<ExecTaskColumnKey, number>> = {};
    if (j.widths && typeof j.widths === "object") {
      for (const [key, val] of Object.entries(j.widths)) {
        const nk = normalizeKey(key);
        if (nk !== null && typeof val === "number") widths[nk] = val;
      }
    }
    return { order: fullOrder, visible, widths };
  } catch {
    return null;
  }
}

export function useExecutionTaskColumns() {
  const [config, setConfig] = useState<ExecTaskColumnConfig>(() => ({
    order: DEFAULT_ORDER,
    visible: { ...DEFAULT_VISIBLE },
    widths: {},
  }));
  const mountedRef = useRef(false);

  // 本 hook 不再使用 localStorage；由上层组件负责从数据库加载/保存。
  useEffect(() => {
    mountedRef.current = true;
  }, []);

  const visibleOrdered = useMemo(
    () => config.order.filter((k) => config.visible[k] !== false),
    [config.order, config.visible],
  );

  const widthFor = useCallback(
    (k: ExecTaskColumnKey) => config.widths[k] ?? DEFAULT_WIDTH[k],
    [config.widths],
  );

  const setVisible = useCallback((k: ExecTaskColumnKey, show: boolean) => {
    setConfig((prev) => ({
      ...prev,
      visible: { ...prev.visible, [k]: show },
    }));
  }, []);

  const moveKey = useCallback((k: ExecTaskColumnKey, delta: -1 | 1) => {
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

  const setWidth = useCallback((k: ExecTaskColumnKey, w: number) => {
    const width = Math.max(72, Math.min(980, Math.round(w)));
    setConfig((prev) => ({
      ...prev,
      widths: { ...prev.widths, [k]: width },
    }));
  }, []);

  const resetDefaults = useCallback(() => {
    setConfig({ order: DEFAULT_ORDER, visible: { ...DEFAULT_VISIBLE }, widths: {} });
  }, []);

  return {
    config,
    setConfig,
    visibleOrdered,
    setVisible,
    moveKey,
    setWidth,
    widthFor,
    resetDefaults,
    defaultConfig: { order: DEFAULT_ORDER, visible: { ...DEFAULT_VISIBLE }, widths: {} },
  };
}

