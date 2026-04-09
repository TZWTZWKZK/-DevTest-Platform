"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeColumnOrder } from "@/lib/normalize-column-order";

const STORAGE_KEY = "pm-requirement-list-columns-v4";

export const REQUIREMENT_COLUMN_KEYS = [
  "title",
  "priority",
  "status",
  "taskProgress",
  "latestProgress",
  "submitter",
  "devOwner",
  "testOwner",
  "planStartAt",
  "planEndAt",
  "createdAt",
  "updatedAt",
] as const;

export type RequirementColumnKey = (typeof REQUIREMENT_COLUMN_KEYS)[number];

export const REQUIREMENT_COLUMN_LABELS: Record<RequirementColumnKey, string> = {
  title: "任务名称",
  priority: "优先级",
  status: "状态",
  taskProgress: "任务进度",
  latestProgress: "最新进展情况",
  submitter: "提交人",
  devOwner: "开发负责人",
  testOwner: "测试负责人",
  planStartAt: "计划开始时间",
  planEndAt: "计划结束时间",
  createdAt: "创建时间",
  updatedAt: "更新时间",
};

const DEFAULT_ORDER: RequirementColumnKey[] = [...REQUIREMENT_COLUMN_KEYS];

const DEFAULT_VISIBLE: Record<RequirementColumnKey, boolean> = {
  title: true,
  priority: true,
  status: true,
  taskProgress: true,
  latestProgress: true,
  submitter: true,
  devOwner: true,
  testOwner: true,
  planStartAt: true,
  planEndAt: true,
  createdAt: true,
  updatedAt: true,
};

const DEFAULT_WIDTH: Record<RequirementColumnKey, number> = {
  title: 360,
  priority: 90,
  status: 120,
  taskProgress: 140,
  latestProgress: 220,
  submitter: 120,
  devOwner: 120,
  testOwner: 120,
  planStartAt: 170,
  planEndAt: 170,
  createdAt: 170,
  updatedAt: 170,
};

export type RequirementColumnConfig = {
  order: RequirementColumnKey[];
  visible: Record<RequirementColumnKey, boolean>;
  widths: Record<RequirementColumnKey, number>;
};

function parseStored(): RequirementColumnConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Partial<RequirementColumnConfig>;

    const order = Array.isArray(j.order)
      ? j.order.filter((k): k is RequirementColumnKey =>
          REQUIREMENT_COLUMN_KEYS.includes(k as RequirementColumnKey),
        )
      : [];
    const fullOrder = normalizeColumnOrder(order, DEFAULT_ORDER);

    const visible = { ...DEFAULT_VISIBLE, ...(j.visible ?? {}) } as Record<
      RequirementColumnKey,
      boolean
    >;

    const widthsPartial = (j.widths ?? {}) as Partial<
      Record<RequirementColumnKey, number>
    >;
    const widths = { ...DEFAULT_WIDTH } as Record<RequirementColumnKey, number>;
    for (const k of REQUIREMENT_COLUMN_KEYS) {
      const w = widthsPartial[k];
      if (typeof w === "number" && Number.isFinite(w) && w >= 60 && w <= 800) {
        widths[k] = Math.round(w);
      }
    }

    return { order: fullOrder, visible, widths };
  } catch {
    return null;
  }
}

function saveStored(c: RequirementColumnConfig) {
  if (typeof window === "undefined") return;
  const payload: RequirementColumnConfig = {
    ...c,
    order: normalizeColumnOrder(c.order, DEFAULT_ORDER),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

export function useRequirementTreeColumns() {
  const [config, setConfig] = useState<RequirementColumnConfig>(() => ({
    order: DEFAULT_ORDER,
    visible: { ...DEFAULT_VISIBLE },
    widths: { ...DEFAULT_WIDTH },
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
    const t = setTimeout(() => saveStored(config), 250);
    return () => clearTimeout(t);
  }, [config]);

  const visibleOrdered = useMemo(() => {
    return config.order.filter((k) => config.visible[k] !== false);
  }, [config.order, config.visible]);

  const setVisible = useCallback((key: RequirementColumnKey, show: boolean) => {
    skipNextPersist.current = true;
    setConfig((prev) => {
      const next: RequirementColumnConfig = {
        ...prev,
        visible: { ...prev.visible, [key]: show },
        order: normalizeColumnOrder(prev.order, DEFAULT_ORDER),
      };
      saveStored(next);
      return next;
    });
  }, []);

  const moveKey = useCallback((key: RequirementColumnKey, delta: -1 | 1) => {
    skipNextPersist.current = true;
    setConfig((prev) => {
      const o = [...prev.order];
      const i = o.indexOf(key);
      if (i < 0) return prev;
      const j = i + delta;
      if (j < 0 || j >= o.length) return prev;
      [o[i], o[j]] = [o[j], o[i]];
      const next: RequirementColumnConfig = {
        ...prev,
        order: normalizeColumnOrder(o, DEFAULT_ORDER),
      };
      saveStored(next);
      return next;
    });
  }, []);

  const setWidth = useCallback((key: RequirementColumnKey, width: number) => {
    const w = Math.max(60, Math.min(800, Math.round(width)));
    setConfig((prev) => ({
      ...prev,
      widths: { ...prev.widths, [key]: w },
    }));
  }, []);

  const resetDefaults = useCallback(() => {
    skipNextPersist.current = true;
    const next: RequirementColumnConfig = {
      order: [...DEFAULT_ORDER],
      visible: { ...DEFAULT_VISIBLE },
      widths: { ...DEFAULT_WIDTH },
    };
    saveStored(next);
    setConfig(next);
  }, []);

  return { config, visibleOrdered, setVisible, moveKey, setWidth, resetDefaults };
}

