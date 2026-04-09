"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeColumnOrder } from "@/lib/normalize-column-order";

const STORAGE_KEY = "pm-iteration-list-columns-v1";

export const ITERATION_COLUMN_KEYS = [
  "name",
  "code",
  "startDate",
  "endDate",
  "status",
  "submitter",
  "createdAt",
  "updatedAt",
] as const;

export type IterationColumnKey = (typeof ITERATION_COLUMN_KEYS)[number];

export const ITERATION_COLUMN_LABELS: Record<IterationColumnKey, string> = {
  name: "迭代名称",
  code: "迭代编码",
  startDate: "开始时间",
  endDate: "结束时间",
  status: "状态",
  submitter: "提交人",
  createdAt: "创建时间",
  updatedAt: "更新时间",
};

const DEFAULT_WIDTH: Record<IterationColumnKey, number> = {
  name: 200,
  code: 150,
  startDate: 118,
  endDate: 118,
  status: 96,
  submitter: 96,
  createdAt: 160,
  updatedAt: 160,
};

const DEFAULT_ORDER: IterationColumnKey[] = [...ITERATION_COLUMN_KEYS];

const DEFAULT_VISIBLE: Record<IterationColumnKey, boolean> = {
  name: true,
  code: true,
  startDate: true,
  endDate: true,
  status: true,
  submitter: true,
  createdAt: true,
  updatedAt: true,
};

export type IterationColumnConfig = {
  order: IterationColumnKey[];
  visible: Record<IterationColumnKey, boolean>;
  widths: Partial<Record<IterationColumnKey, number>>;
};

function normalizeKey(key: string): IterationColumnKey | null {
  const k = key as IterationColumnKey;
  return ITERATION_COLUMN_KEYS.includes(k) ? k : null;
}

function parseStored(): IterationColumnConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<
      IterationColumnConfig & {
        order?: string[];
        visible?: Record<string, boolean>;
        widths?: Record<string, number>;
      }
    >;
    const order = Array.isArray(j.order)
      ? j.order
          .map(normalizeKey)
          .filter((k): k is IterationColumnKey => k !== null)
      : [];
    const fullOrder = normalizeColumnOrder(order, DEFAULT_ORDER);
    const visible: Record<IterationColumnKey, boolean> = { ...DEFAULT_VISIBLE };
    if (j.visible && typeof j.visible === "object") {
      for (const [key, val] of Object.entries(j.visible)) {
        const nk = normalizeKey(key);
        if (nk !== null && typeof val === "boolean") visible[nk] = val;
      }
    }
    const widths: Partial<Record<IterationColumnKey, number>> = {};
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

function saveStored(c: IterationColumnConfig) {
  if (typeof window === "undefined") return;
  const payload: IterationColumnConfig = {
    ...c,
    order: normalizeColumnOrder(c.order, DEFAULT_ORDER),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function clampIterWidth(px: number): number {
  return Math.max(72, Math.min(440, Math.round(px)));
}

export function useIterationListColumns() {
  const [config, setConfig] = useState<IterationColumnConfig>(() => ({
    order: DEFAULT_ORDER,
    visible: { ...DEFAULT_VISIBLE },
    widths: {},
  }));
  const skipNextPersist = useRef(true);

  useEffect(() => {
    const loaded = parseStored();
    if (loaded) setConfig(loaded);
  }, []);

  useEffect(() => {
    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }
    const t = setTimeout(() => saveStored(config), 350);
    return () => clearTimeout(t);
  }, [config]);

  const visibleOrdered = useMemo(() => {
    return config.order.filter((k) => config.visible[k] !== false);
  }, [config.order, config.visible]);

  const setVisible = useCallback((key: IterationColumnKey, show: boolean) => {
    skipNextPersist.current = true;
    setConfig((prev) => {
      const next: IterationColumnConfig = {
        ...prev,
        visible: { ...prev.visible, [key]: show },
        order: normalizeColumnOrder(prev.order, DEFAULT_ORDER),
      };
      saveStored(next);
      return next;
    });
  }, []);

  const moveKey = useCallback((key: IterationColumnKey, delta: -1 | 1) => {
    skipNextPersist.current = true;
    setConfig((prev) => {
      const o = [...prev.order];
      const i = o.indexOf(key);
      if (i < 0) return prev;
      const j = i + delta;
      if (j < 0 || j >= o.length) return prev;
      [o[i], o[j]] = [o[j], o[i]];
      const next: IterationColumnConfig = {
        ...prev,
        order: normalizeColumnOrder(o, DEFAULT_ORDER),
      };
      saveStored(next);
      return next;
    });
  }, []);

  const setWidth = useCallback((key: IterationColumnKey, px: number) => {
    setConfig((prev) => ({
      ...prev,
      widths: { ...prev.widths, [key]: clampIterWidth(px) },
    }));
  }, []);

  const widthFor = useCallback(
    (key: IterationColumnKey) => config.widths[key] ?? DEFAULT_WIDTH[key],
    [config.widths],
  );

  const resetDefaults = useCallback(() => {
    skipNextPersist.current = true;
    const next: IterationColumnConfig = {
      order: [...DEFAULT_ORDER],
      visible: { ...DEFAULT_VISIBLE },
      widths: {},
    };
    saveStored(next);
    setConfig(next);
  }, []);

  return {
    config,
    visibleOrdered,
    setVisible,
    moveKey,
    setWidth,
    widthFor,
    resetDefaults,
  };
}
