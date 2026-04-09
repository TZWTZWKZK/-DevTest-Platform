"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeColumnOrder } from "@/lib/normalize-column-order";

const STORAGE_KEY = "pm-defect-list-columns-v3";

export const DEFECT_COLUMN_KEYS = [
  "defectNo",
  "name",
  "status",
  "severity",
  "iterationCode",
  "caseNo",
  "devOwner",
  "submitter",
  "linkedTestId",
  "linkedProject",
  "reopenCount",
  "createdAt",
  "updatedBy",
  "updatedAt",
] as const;

export type DefectColumnKey = (typeof DEFECT_COLUMN_KEYS)[number];

export const DEFECT_COLUMN_LABELS: Record<DefectColumnKey, string> = {
  defectNo: "缺陷编号",
  name: "缺陷名称",
  status: "状态",
  severity: "严重等级",
  iterationCode: "关联迭代",
  caseNo: "用例编号",
  devOwner: "开发责任人",
  submitter: "提交人",
  linkedTestId: "关联测试ID",
  linkedProject: "关联项目",
  reopenCount: "缺陷重开次数",
  createdAt: "创建时间",
  updatedBy: "修改人",
  updatedAt: "修改时间",
};

const DEFAULT_WIDTH: Record<DefectColumnKey, number> = {
  defectNo: 160,
  name: 260,
  status: 96,
  severity: 84,
  iterationCode: 190,
  caseNo: 140,
  devOwner: 110,
  submitter: 96,
  linkedTestId: 150,
  linkedProject: 160,
  reopenCount: 96,
  createdAt: 152,
  updatedBy: 100,
  updatedAt: 160,
};

const DEFAULT_ORDER: DefectColumnKey[] = [...DEFECT_COLUMN_KEYS];

const DEFAULT_VISIBLE: Record<DefectColumnKey, boolean> = {
  defectNo: true,
  name: true,
  status: true,
  severity: true,
  iterationCode: true,
  caseNo: true,
  devOwner: true,
  submitter: true,
  linkedTestId: true,
  linkedProject: true,
  reopenCount: true,
  createdAt: true,
  updatedBy: true,
  updatedAt: true,
};

export type ColumnConfig = {
  order: DefectColumnKey[];
  visible: Record<DefectColumnKey, boolean>;
  widths: Partial<Record<DefectColumnKey, number>>;
};

function normalizeKey(key: string): DefectColumnKey | null {
  const k = key as DefectColumnKey;
  return DEFECT_COLUMN_KEYS.includes(k) ? k : null;
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
      ? j.order
          .map(normalizeKey)
          .filter((k): k is DefectColumnKey => k !== null)
      : [];
    const fullOrder = normalizeColumnOrder(order, DEFAULT_ORDER);
    const visible: Record<DefectColumnKey, boolean> = { ...DEFAULT_VISIBLE };
    if (j.visible && typeof j.visible === "object") {
      for (const [key, val] of Object.entries(j.visible)) {
        const nk = normalizeKey(key);
        if (nk !== null && typeof val === "boolean") visible[nk] = val;
      }
    }
    const widths: Partial<Record<DefectColumnKey, number>> = {};
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

function saveStored(c: ColumnConfig) {
  if (typeof window === "undefined") return;
  const payload: ColumnConfig = {
    ...c,
    order: normalizeColumnOrder(c.order, DEFAULT_ORDER),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function useDefectListColumns() {
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

  const setVisible = useCallback((key: DefectColumnKey, show: boolean) => {
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

  const moveKey = useCallback((key: DefectColumnKey, delta: -1 | 1) => {
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

  const setWidth = useCallback((key: DefectColumnKey, px: number) => {
    const w = Math.max(56, Math.min(720, Math.round(px)));
    setConfig((prev) => ({
      ...prev,
      widths: { ...prev.widths, [key]: w },
    }));
  }, []);

  const widthFor = useCallback(
    (key: DefectColumnKey) => config.widths[key] ?? DEFAULT_WIDTH[key],
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

  return { config, visibleOrdered, setVisible, moveKey, setWidth, widthFor, resetDefaults };
}

