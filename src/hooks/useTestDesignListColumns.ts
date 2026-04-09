"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeColumnOrder } from "@/lib/normalize-column-order";

const STORAGE_KEY = "pm-test-design-list-columns-v1";

export const TEST_DESIGN_COLUMN_KEYS = [
  "title",
  "linkedCases",
  "type",
  "createdBy",
  "updatedBy",
  "createdAt",
  "updatedAt",
] as const;

export type TestDesignColumnKey = (typeof TEST_DESIGN_COLUMN_KEYS)[number];

export const TEST_DESIGN_COLUMN_LABELS: Record<TestDesignColumnKey, string> = {
  title: "标题",
  linkedCases: "关联用例",
  type: "类型",
  createdBy: "创建人",
  updatedBy: "修改人",
  createdAt: "创建时间",
  updatedAt: "更新时间",
};

const DEFAULT_WIDTH: Record<TestDesignColumnKey, number> = {
  title: 420,
  linkedCases: 140,
  type: 120,
  createdBy: 112,
  updatedBy: 112,
  createdAt: 180,
  updatedAt: 180,
};

const WIDTH_BOUNDS: Record<TestDesignColumnKey, { min: number; max: number }> = {
  title: { min: 120, max: 800 },
  linkedCases: { min: 112, max: 220 },
  type: { min: 96, max: 280 },
  createdBy: { min: 72, max: 360 },
  updatedBy: { min: 72, max: 360 },
  createdAt: { min: 100, max: 360 },
  updatedAt: { min: 100, max: 360 },
};

const DEFAULT_ORDER: TestDesignColumnKey[] = [...TEST_DESIGN_COLUMN_KEYS];

const DEFAULT_VISIBLE: Record<TestDesignColumnKey, boolean> = {
  title: true,
  linkedCases: true,
  type: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
};

export type TestDesignColumnConfig = {
  order: TestDesignColumnKey[];
  visible: Record<TestDesignColumnKey, boolean>;
  widths: Partial<Record<TestDesignColumnKey, number>>;
};

function normalizeKey(key: string): TestDesignColumnKey | null {
  const k = key as TestDesignColumnKey;
  return TEST_DESIGN_COLUMN_KEYS.includes(k) ? k : null;
}

function parseStored(): TestDesignColumnConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<
      TestDesignColumnConfig & {
        order?: string[];
        visible?: Record<string, boolean>;
        widths?: Record<string, number>;
      }
    >;
    const order = Array.isArray(j.order)
      ? j.order
          .map(normalizeKey)
          .filter((k): k is TestDesignColumnKey => k !== null)
      : [];
    const fullOrder = normalizeColumnOrder(order, DEFAULT_ORDER);
    const visible: Record<TestDesignColumnKey, boolean> = { ...DEFAULT_VISIBLE };
    if (j.visible && typeof j.visible === "object") {
      for (const [key, val] of Object.entries(j.visible)) {
        const nk = normalizeKey(key);
        if (nk !== null && typeof val === "boolean") visible[nk] = val;
      }
    }
    const widths: Partial<Record<TestDesignColumnKey, number>> = {};
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

function saveStored(c: TestDesignColumnConfig) {
  if (typeof window === "undefined") return;
  const payload: TestDesignColumnConfig = {
    ...c,
    order: normalizeColumnOrder(c.order, DEFAULT_ORDER),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function clampDesignWidth(key: TestDesignColumnKey, px: number): number {
  const { min, max } = WIDTH_BOUNDS[key];
  return Math.max(min, Math.min(max, Math.round(px)));
}

export function useTestDesignListColumns() {
  const [config, setConfig] = useState<TestDesignColumnConfig>(() => ({
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

  const setVisible = useCallback((key: TestDesignColumnKey, show: boolean) => {
    skipNextPersist.current = true;
    setConfig((prev) => {
      const next: TestDesignColumnConfig = {
        ...prev,
        visible: { ...prev.visible, [key]: show },
        order: normalizeColumnOrder(prev.order, DEFAULT_ORDER),
      };
      saveStored(next);
      return next;
    });
  }, []);

  const moveKey = useCallback((key: TestDesignColumnKey, delta: -1 | 1) => {
    skipNextPersist.current = true;
    setConfig((prev) => {
      const o = [...prev.order];
      const i = o.indexOf(key);
      if (i < 0) return prev;
      const j = i + delta;
      if (j < 0 || j >= o.length) return prev;
      [o[i], o[j]] = [o[j], o[i]];
      const next: TestDesignColumnConfig = {
        ...prev,
        order: normalizeColumnOrder(o, DEFAULT_ORDER),
      };
      saveStored(next);
      return next;
    });
  }, []);

  const setWidth = useCallback((key: TestDesignColumnKey, px: number) => {
    setConfig((prev) => ({
      ...prev,
      widths: { ...prev.widths, [key]: clampDesignWidth(key, px) },
    }));
  }, []);

  const widthFor = useCallback(
    (key: TestDesignColumnKey) => config.widths[key] ?? DEFAULT_WIDTH[key],
    [config.widths],
  );

  const resetDefaults = useCallback(() => {
    skipNextPersist.current = true;
    const next: TestDesignColumnConfig = {
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
