"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeColumnOrder } from "@/lib/normalize-column-order";

const STORAGE_KEY = "pm-testcase-list-columns-v1";

export const DATA_COLUMN_KEYS = [
  "caseNo",
  "title",
  "folderPath",
  "status",
  "priority",
  "maintainer",
  "submitter",
  "createdAt",
  "updatedAt",
] as const;

export type DataColumnKey = (typeof DATA_COLUMN_KEYS)[number];

export const COLUMN_LABELS: Record<DataColumnKey, string> = {
  caseNo: "用例编号",
  title: "用例名称",
  folderPath: "所在目录",
  status: "状态",
  priority: "用例等级",
  maintainer: "维护人",
  submitter: "提交人",
  createdAt: "创建时间",
  updatedAt: "更新时间",
};

const DEFAULT_WIDTH: Record<DataColumnKey, number> = {
  caseNo: 120,
  title: 180,
  folderPath: 200,
  status: 88,
  priority: 72,
  maintainer: 96,
  submitter: 88,
  createdAt: 152,
  updatedAt: 152,
};

const DEFAULT_ORDER: DataColumnKey[] = [...DATA_COLUMN_KEYS];

const DEFAULT_VISIBLE: Record<DataColumnKey, boolean> = {
  caseNo: true,
  title: true,
  folderPath: true,
  status: true,
  priority: true,
  maintainer: true,
  submitter: true,
  createdAt: true,
  updatedAt: true,
};

export type ColumnConfig = {
  order: DataColumnKey[];
  visible: Record<DataColumnKey, boolean>;
  widths: Partial<Record<DataColumnKey, number>>;
};

/** 旧版「提交时间」列键迁移为创建时间 */
const LEGACY_COLUMN_KEY: Record<string, DataColumnKey | undefined> = {
  submittedAt: "createdAt",
};

function normalizeColumnKey(key: string): DataColumnKey | null {
  const k = (LEGACY_COLUMN_KEY[key] ?? key) as DataColumnKey;
  return DATA_COLUMN_KEYS.includes(k) ? k : null;
}

function parseStored(): ColumnConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<
      ColumnConfig & {
        order?: string[];
        visible?: Record<string, boolean>;
        widths?: Record<string, number>;
      }
    >;
    const order = Array.isArray(j.order)
      ? j.order.map(normalizeColumnKey).filter((k): k is DataColumnKey => k !== null)
      : [];
    const fullOrder = normalizeColumnOrder(order, DEFAULT_ORDER);
    const visible: Record<DataColumnKey, boolean> = { ...DEFAULT_VISIBLE };
    if (j.visible && typeof j.visible === "object") {
      for (const [key, val] of Object.entries(j.visible)) {
        const nk = normalizeColumnKey(key);
        if (nk !== null && typeof val === "boolean") visible[nk] = val;
      }
    }
    const widths: Partial<Record<DataColumnKey, number>> = {};
    if (j.widths && typeof j.widths === "object") {
      for (const [key, val] of Object.entries(j.widths)) {
        const nk = normalizeColumnKey(key);
        if (nk !== null && typeof val === "number") widths[nk] = val;
      }
    }
    return { order: fullOrder, visible, widths };
  } catch {
    return null;
  }
}

function saveStored(c: ColumnConfig) {
  if (typeof window === "undefined") return;
  const payload: ColumnConfig = {
    ...c,
    order: normalizeColumnOrder(c.order, DEFAULT_ORDER),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function useTestCaseListColumns() {
  const [config, setConfig] = useState<ColumnConfig>(() => ({
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

  const setVisible = useCallback((key: DataColumnKey, show: boolean) => {
    skipNextPersist.current = true;
    setConfig((prev) => {
      const next: ColumnConfig = {
        ...prev,
        visible: { ...prev.visible, [key]: show },
        order: normalizeColumnOrder(prev.order, DEFAULT_ORDER),
      };
      saveStored(next);
      return next;
    });
  }, []);

  const moveKey = useCallback((key: DataColumnKey, delta: -1 | 1) => {
    skipNextPersist.current = true;
    setConfig((prev) => {
      const o = [...prev.order];
      const i = o.indexOf(key);
      if (i < 0) return prev;
      const j = i + delta;
      if (j < 0 || j >= o.length) return prev;
      [o[i], o[j]] = [o[j], o[i]];
      const next: ColumnConfig = {
        ...prev,
        order: normalizeColumnOrder(o, DEFAULT_ORDER),
      };
      saveStored(next);
      return next;
    });
  }, []);

  const setWidth = useCallback((key: DataColumnKey, px: number) => {
    const w = Math.max(48, Math.min(640, Math.round(px)));
    setConfig((prev) => ({
      ...prev,
      widths: { ...prev.widths, [key]: w },
    }));
  }, []);

  const widthFor = useCallback(
    (key: DataColumnKey) => config.widths[key] ?? DEFAULT_WIDTH[key],
    [config.widths],
  );

  const resetDefaults = useCallback(() => {
    skipNextPersist.current = true;
    const next: ColumnConfig = {
      order: [...DEFAULT_ORDER],
      visible: { ...DEFAULT_VISIBLE },
      widths: {},
    };
    saveStored(next);
    setConfig(next);
  }, []);

  return {
    visibleOrdered,
    config,
    setVisible,
    moveKey,
    setWidth,
    widthFor,
    resetDefaults,
  };
}
