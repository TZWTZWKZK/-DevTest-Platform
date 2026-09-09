"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  addDefectLinkedTestCases,
  bulkDeleteDefects,
  getDefectFull,
  listDefects,
  removeDefectLinkedTestCases,
  saveDefect,
  type DefectSeverity,
  type DefectStatus,
  type DefectListItem,
  type DefectLinkedTestCase,
} from "@/app/actions/defects";
import { listProductOptions, type ProductOption } from "@/app/actions/products";
import { listIterationCodeOptions } from "@/app/actions/iterations";
import {
  getGlobalIterationProductPreference,
  saveGlobalIterationProductPreference,
} from "@/app/actions/executions";
import {
  listTestCaseIdOptions,
  searchTestCaseIdOptions,
  type TestCaseIdOption,
} from "@/app/actions/test-cases";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
} from "@/components/PageModuleLayout";
import { PaginationBar } from "@/components/PaginationBar";
import { TableColumnResizeHandle } from "@/components/TableColumnResizeHandle";
import {
  DEFECT_COLUMN_LABELS,
  type DefectColumnKey,
  useDefectListColumns,
} from "@/hooks/useDefectListColumns";
import { usePagination } from "@/hooks/usePagination";
import { useRowCheckboxBrushByIds } from "@/hooks/useRowCheckboxBrushByIds";

const statusLabel: Record<DefectStatus, string> = {
  UNASSIGNED: "未分配",
  IN_DEVELOPMENT: "开发中",
  TESTING: "测试",
  CLOSED: "已关闭",
  REOPENED: "重开",
};

const statusBadgeClass: Record<DefectStatus, string> = {
  UNASSIGNED: "border-red-500/80 bg-red-50 text-red-800",
  IN_DEVELOPMENT: "border-amber-500/80 bg-amber-50 text-amber-900",
  TESTING: "border-emerald-500/80 bg-emerald-50 text-emerald-800",
  CLOSED: "border-zinc-400 bg-zinc-100 text-zinc-600",
  REOPENED: "border-orange-500/80 bg-orange-50 text-orange-800",
};

const severityLabel: Record<DefectSeverity, string> = {
  CRITICAL: "致命",
  HIGH: "严重",
  MEDIUM: "一般",
  LOW: "建议",
};

const severityBadgeClass: Record<DefectSeverity, string> = {
  CRITICAL: "border-zinc-900 bg-zinc-900 text-white",
  HIGH: "border-red-500/80 bg-red-50 text-red-800",
  MEDIUM: "border-orange-500/80 bg-orange-50 text-orange-800",
  LOW: "border-blue-500/80 bg-blue-50 text-blue-800",
};

function formatTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** 缺陷修改时间：精确到秒 */
function formatUpdatedAtTs(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function newDescImageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** 与「产品」分列展示时，迭代选项去掉「产品名 / 」前缀避免重复 */
function iterationSelectShortLabel(o: { code: string; label: string }): string {
  if (!o.code) return o.label;
  const sep = " / ";
  const i = o.label.indexOf(sep);
  if (i >= 0) return o.label.slice(i + sep.length);
  return o.label;
}

type Adv = {
  q: string;
  status: DefectStatus | "";
  severity: DefectSeverity | "";
  iterationCode: string;
  linkedProject: string;
  caseNo: string;
  devOwner: string;
  submitter: string;
  reopenCountMin: string;
  reopenCountMax: string;
  createdFrom: string;
  createdTo: string;
  updatedFrom: string;
  updatedTo: string;
  updatedBy: string;
};

const DEFAULT_ADV: Adv = {
  q: "",
  status: "",
  severity: "",
  iterationCode: "",
  linkedProject: "",
  caseNo: "",
  devOwner: "",
  submitter: "",
  reopenCountMin: "",
  reopenCountMax: "",
  createdFrom: "",
  createdTo: "",
  updatedFrom: "",
  updatedTo: "",
  updatedBy: "",
};

export function DefectManagementClient() {
  const [rows, setRows] = useState<DefectListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [adv, setAdv] = useState<Adv>({ ...DEFAULT_ADV });

  const cols = useDefectListColumns();
  const [colMenuOpen, setColMenuOpen] = useState(false);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const selectAllFullVisibleRef = useRef<HTMLInputElement | null>(null);
  const addLinkSelectAllRef = useRef<HTMLInputElement | null>(null);
  const [batchWorking, setBatchWorking] = useState(false);

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [productId, setProductId] = useState("");
  const productPrefHydratedRef = useRef(false);
  const productLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of products) {
      const label = p.code ? `${p.name}（${p.code}）` : p.name;
      m.set(p.id, label);
    }
    return m;
  }, [products]);

  const [caseOptions, setCaseOptions] = useState<TestCaseIdOption[]>([]);
  const [iterationOptions, setIterationOptions] = useState<
    { code: string; label: string; productId?: string | null }[]
  >([{ code: "", label: "baseline（全部迭代）", productId: null }]);
  const visibleIterationOptions = useMemo(
    () =>
      productId
        ? iterationOptions.filter(
            (o) => o.code === "" || (o.productId ?? "") === productId,
          )
        : iterationOptions,
    [iterationOptions, productId],
  );

  const iterationLabelByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of iterationOptions) m.set(it.code, it.label);
    return m;
  }, [iterationOptions]);
  const caseLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of caseOptions) {
      m.set(c.id, `${c.caseNo} ${c.title}`);
    }
    return m;
  }, [caseOptions]);

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<"desc" | "cases" | "ops">("desc");
  const [linkedCases, setLinkedCases] = useState<DefectLinkedTestCase[]>([]);
  const [opLogs, setOpLogs] = useState<Array<{ id: string; action: string; detail: string | null; createdAt: string }>>([]);
  const [linkBusy, setLinkBusy] = useState(false);
  const [selectedLinkIds, setSelectedLinkIds] = useState<string[]>([]);
  const [addLinkSelectedIds, setAddLinkSelectedIds] = useState<string[]>([]);
  const [addLinkPanelOpen, setAddLinkPanelOpen] = useState(false);
  const [addLinkQuery, setAddLinkQuery] = useState("");
  /** 添加关联用例弹层内：与列表「产品」可独立选择 */
  const [addLinkProductId, setAddLinkProductId] = useState("");
  const [addLinkIterCode, setAddLinkIterCode] = useState("");
  const [addLinkResults, setAddLinkResults] = useState<TestCaseIdOption[]>([]);
  const [addLinkLoading, setAddLinkLoading] = useState(false);

  /** 添加关联用例：选中具体产品时只显示该产品下的迭代；选「全部产品」时列出全部（含产品前缀） */
  const addLinkIterationOptions = useMemo(() => {
    const pid = addLinkProductId.trim();
    if (!pid) {
      return iterationOptions;
    }
    return iterationOptions.filter(
      (o) => o.code === "" || (o.productId ?? "") === pid,
    );
  }, [addLinkProductId, iterationOptions]);

  const [createdAtIso, setCreatedAtIso] = useState<string | null>(null);
  const [lastUpdatedAtIso, setLastUpdatedAtIso] = useState<string | null>(null);
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const [descText, setDescText] = useState("");
  const [descImages, setDescImages] = useState<
    Array<{ id: string; name: string; dataUrl: string }>
  >([]);
  const [imgPreviewOpen, setImgPreviewOpen] = useState(false);
  const [imgPreviewSrc, setImgPreviewSrc] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    defectNo: "",
    name: "",
    status: "UNASSIGNED" as DefectStatus,
    severity: "MEDIUM" as DefectSeverity,
    iterationCode: "",
    caseNo: "",
    devOwner: "",
    submitter: "",
    foundAt: "",
    description: "",
    linkedTestId: "",
    linkedProject: "",
    reopenCount: "0",
    updatedBy: "",
  });
  const [saveBusy, setSaveBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [linkedCaseTblChkW, setLinkedCaseTblChkW] = useState(40);
  const [linkedCaseTblNoW, setLinkedCaseTblNoW] = useState(120);
  const [linkedCaseTblTitleW, setLinkedCaseTblTitleW] = useState(220);
  const [addLinkTblChkW, setAddLinkTblChkW] = useState(40);
  const [addLinkTblNoW, setAddLinkTblNoW] = useState(128);

  const reload = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await listDefects({
        q: adv.q,
        status: adv.status,
        severity: adv.severity,
        iterationCode: adv.iterationCode,
        linkedProject: adv.linkedProject,
        caseNo: adv.caseNo,
        devOwner: adv.devOwner,
        submitter: adv.submitter,
        reopenCountMin: adv.reopenCountMin,
        reopenCountMax: adv.reopenCountMax,
        createdFrom: adv.createdFrom,
        createdTo: adv.createdTo,
        updatedFrom: adv.updatedFrom,
        updatedTo: adv.updatedTo,
        updatedBy: adv.updatedBy,
      });
      setRows(data);
      setSelectedIds([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [adv]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    (async () => {
      try {
        const [ps, its] = await Promise.all([
          listProductOptions(),
          listIterationCodeOptions(),
        ]);
        setProducts(ps);
        setIterationOptions(its);
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    const pid = productId.trim();
    if (!pid) {
      setCaseOptions([]);
      return;
    }
    void (async () => {
      try {
        const cs = await listTestCaseIdOptions({ productId: pid });
        setCaseOptions(cs);
      } catch {
        setCaseOptions([]);
      }
    })();
  }, [productId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pref = await getGlobalIterationProductPreference();
      if (cancelled) return;
      const candidate = (pref.productId ?? "").trim();
      if (candidate) setProductId(candidate);
      productPrefHydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (productId) return;
    if (products.length > 0) setProductId(products[0]!.id);
  }, [productId, products]);

  useEffect(() => {
    if (!productPrefHydratedRef.current || !productId) return;
    setAdv((p) => ({ ...p, linkedProject: productId }));
    setDraft((p) => ({ ...p, linkedProject: p.linkedProject || productId }));
    const t = window.setTimeout(() => {
      void saveGlobalIterationProductPreference({ productId });
    }, 400);
    return () => clearTimeout(t);
  }, [productId]);

  useEffect(() => {
    if (!visibleIterationOptions.some((o) => o.code === adv.iterationCode)) {
      setAdv((p) => ({ ...p, iterationCode: "" }));
    }
  }, [visibleIterationOptions, adv.iterationCode]);

  const addLinkPickSet = useMemo(
    () => new Set(addLinkSelectedIds),
    [addLinkSelectedIds],
  );

  const linkedCaseIdSetForAddPanel = useMemo(
    () => new Set(linkedCases.map((l) => l.id)),
    [linkedCases],
  );

  useEffect(() => {
    setAddLinkSelectedIds([]);
  }, [addLinkResults]);

  useEffect(() => {
    const el = addLinkSelectAllRef.current;
    if (!el) return;
    if (addLinkResults.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const rowChecked = (c: TestCaseIdOption) =>
      linkedCaseIdSetForAddPanel.has(c.id) || addLinkPickSet.has(c.id);
    const all = addLinkResults.every(rowChecked);
    const some = addLinkResults.some(rowChecked);
    el.indeterminate = some && !all;
    el.checked = all;
  }, [addLinkPickSet, addLinkResults, linkedCaseIdSetForAddPanel]);

  const openCreate = () => {
    setEditId(null);
    setEditTab("desc");
    setLinkedCases([]);
    setOpLogs([]);
    setSelectedLinkIds([]);
    setAddLinkSelectedIds([]);
    setAddLinkPanelOpen(false);
    setAddLinkQuery("");
    setAddLinkIterCode("");
    setAddLinkResults([]);
    setCreatedAtIso(null);
    setLastUpdatedAtIso(null);
    setDescText("");
    setDescImages([]);
    setDraft({
      defectNo: "",
      name: "",
      status: "UNASSIGNED",
      severity: "MEDIUM",
      iterationCode: "",
      caseNo: "",
      devOwner: "",
      submitter: "",
      foundAt: new Date().toISOString().slice(0, 10),
      description: "",
      linkedTestId: "",
      linkedProject: "",
      reopenCount: "0",
      updatedBy: "",
    });
    setErr(null);
    setEditOpen(true);
  };

  const openEdit = async (r: DefectListItem) => {
    setEditId(r.id);
    setEditTab("desc");
    setLinkedCases([]);
    setSelectedLinkIds([]);
    setAddLinkSelectedIds([]);
    setAddLinkPanelOpen(false);
    setAddLinkQuery("");
    setAddLinkIterCode("");
    setAddLinkResults([]);
    setCreatedAtIso(null);
    const full = await getDefectFull(r.id);
    const base = full ?? r;
    setCreatedAtIso(full?.createdAt ?? r.createdAt ?? null);
    setLastUpdatedAtIso(full?.updatedAt ?? r.updatedAt ?? null);
    const createdDay = (full?.createdAt ?? r.createdAt ?? "").slice(0, 10);
    const split = (() => {
      const s = base.description ?? "";
      const re = /!\[([^\]]*)]\((data:image\/[^)]+)\)/g;
      const imgs: Array<{ id: string; name: string; dataUrl: string }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) {
        imgs.push({
          id: newDescImageId(),
          name: m[1] || "image",
          dataUrl: m[2]!,
        });
      }
      const cleaned = s.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
      return { text: cleaned, images: imgs };
    })();
    setDescText(split.text);
    setDescImages(split.images);
    setDraft({
      defectNo: base.defectNo,
      name: base.name,
      status: base.status,
      severity: base.severity,
      iterationCode: (base.iterationCode ?? "") as string,
      caseNo: base.caseNo ?? "",
      devOwner: base.devOwner ?? "",
      submitter: base.submitter ?? "",
      foundAt: createdDay || (base.foundAt ? base.foundAt.slice(0, 10) : ""),
      description: base.description ?? "",
      linkedTestId: "",
      linkedProject: base.linkedProject ?? "",
      reopenCount: String(base.reopenCount ?? 0),
      updatedBy: base.updatedBy ?? "",
    });
    if (full?.linkedTestCases) setLinkedCases(full.linkedTestCases);
    setOpLogs(full?.opLogs ?? []);
    setErr(null);
    setEditOpen(true);
  };

  const reloadLinks = useCallback(async () => {
    if (!editId) return;
    const full = await getDefectFull(editId);
    setLinkedCases(full?.linkedTestCases ?? []);
    setOpLogs(full?.opLogs ?? []);
    setSelectedLinkIds([]);
  }, [editId]);

  const addLink = useCallback(async () => {
    if (!editId) return;
    const ids = Array.from(
      new Set(addLinkSelectedIds.map((x) => x.trim()).filter(Boolean)),
    );
    if (ids.length === 0) return;
    setLinkBusy(true);
    const r = await addDefectLinkedTestCases(editId, ids);
    setLinkBusy(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    setAddLinkSelectedIds([]);
    await reloadLinks();
  }, [addLinkSelectedIds, editId, reloadLinks]);

  const toggleAddLinkPick = useCallback((id: string) => {
    setAddLinkSelectedIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return Array.from(s);
    });
  }, []);

  const toggleAddLinkPickAll = useCallback(() => {
    const allRowsChecked = addLinkResults.every(
      (c) =>
        linkedCaseIdSetForAddPanel.has(c.id) || addLinkPickSet.has(c.id),
    );
    if (allRowsChecked) {
      setAddLinkSelectedIds([]);
    } else {
      setAddLinkSelectedIds(addLinkResults.map((c) => c.id));
    }
  }, [addLinkPickSet, addLinkResults, linkedCaseIdSetForAddPanel]);

  const startResizeLinkedChkVsNo = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = linkedCaseTblChkW;
      const b0 = linkedCaseTblNoW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setLinkedCaseTblChkW(Math.min(52, Math.max(32, a0 + dx)));
        setLinkedCaseTblNoW(Math.min(400, Math.max(72, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [linkedCaseTblChkW, linkedCaseTblNoW],
  );

  const startResizeLinkedNoVsTitle = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = linkedCaseTblNoW;
      const b0 = linkedCaseTblTitleW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setLinkedCaseTblNoW(Math.min(400, Math.max(72, a0 + dx)));
        setLinkedCaseTblTitleW(Math.min(640, Math.max(100, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [linkedCaseTblNoW, linkedCaseTblTitleW],
  );

  const startResizeLinkedTitleVsOp = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = linkedCaseTblTitleW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setLinkedCaseTblTitleW(Math.min(720, Math.max(100, a0 + dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [linkedCaseTblTitleW],
  );

  const startResizeAddLinkChkVsNo = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = addLinkTblChkW;
      const b0 = addLinkTblNoW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setAddLinkTblChkW(Math.min(52, Math.max(32, a0 + dx)));
        setAddLinkTblNoW(Math.min(560, Math.max(72, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [addLinkTblChkW, addLinkTblNoW],
  );

  const startResizeAddLinkNoVsTitle = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = addLinkTblNoW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setAddLinkTblNoW(Math.min(560, Math.max(72, a0 + dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [addLinkTblNoW],
  );

  const removeLinks = useCallback(
    async (ids: string[]) => {
      if (!editId) return;
      const uniq = Array.from(new Set(ids.map((x) => x.trim()).filter(Boolean)));
      if (uniq.length === 0) return;
      setLinkBusy(true);
      const r = await removeDefectLinkedTestCases(editId, uniq);
      setLinkBusy(false);
      if (r.error) {
        setErr(r.error);
        return;
      }
      await reloadLinks();
    },
    [editId, reloadLinks],
  );

  // 不提供“替换”能力（按需求去掉），需要调整时先移除再添加

  // 图片已从描述文本中拆出（descImages）；这里不再从 description 里解析

  useEffect(() => {
    if (!addLinkPanelOpen) return;
    const t = window.setTimeout(async () => {
      setAddLinkLoading(true);
      try {
        const rawPid = addLinkProductId.trim();
        const rows = await searchTestCaseIdOptions({
          q: addLinkQuery,
          iterationCode: addLinkIterCode || null,
          take: 20,
          productId: rawPid !== "" ? rawPid : null,
        });
        setAddLinkResults(rows);
      } finally {
        setAddLinkLoading(false);
      }
    }, 220);
    return () => window.clearTimeout(t);
  }, [addLinkIterCode, addLinkPanelOpen, addLinkProductId, addLinkQuery]);

  useEffect(() => {
    if (!addLinkPanelOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      const root = document.getElementById("defect-add-link-panel-root");
      if (root?.contains(e.target)) return;
      setAddLinkPanelOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [addLinkPanelOpen]);

  const runSave = async () => {
    setSaveBusy(true);
    setErr(null);
    const createdDay = (createdAtIso ?? "").slice(0, 10);
    const mergedDesc = (() => {
      const t = (descText ?? "").trim();
      const md = descImages
        .map((x) => `![${x.name}](${x.dataUrl})`)
        .join("\n\n");
      if (!t) return md;
      if (!md) return t;
      return `${t}\n\n${md}\n`;
    })();
    const r = await saveDefect({
      id: editId,
      defectNo: draft.defectNo || null,
      name: draft.name,
      status: draft.status,
      severity: draft.severity,
      iterationCode: draft.iterationCode || null,
      caseNo: null,
      devOwner: draft.devOwner || null,
      submitter: draft.submitter || null,
      foundAt: createdDay || draft.foundAt || null,
      description: mergedDesc || null,
      linkedTestId: null,
      linkedProject: draft.linkedProject || null,
      /** 由服务端维护：新建为 0；更新时沿用库值，仅在 已关闭→重开 时 +1 */
      reopenCount: 0,
      updatedBy: draft.updatedBy.trim() || null,
    });
    setSaveBusy(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    setEditOpen(false);
    void reload();
  };

  const onPickDescImages = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
      if (imgs.length === 0) return;
      for (const f of imgs) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result ?? ""));
          r.onerror = () => reject(new Error("read failed"));
          r.readAsDataURL(f);
        }).catch(() => "");
        if (!dataUrl) continue;
        setDescImages((prev) => [
          ...prev,
          { id: newDescImageId(), name: f.name, dataUrl },
        ]);
      }
    },
    [],
  );

  const runBatchDelete = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(`确定批量删除已选 ${selectedIds.length} 条缺陷？`)) return;
    setBatchWorking(true);
    const r = await bulkDeleteDefects(selectedIds);
    setBatchWorking(false);
    if (r.error) {
      setErr(r.error);
      return;
    }
    void reload();
  };

  const visible = useMemo(() => rows, [rows]);
  const defectPager = usePagination(visible, {
    defaultPageSize: 20,
    storageKey: "pm.pageSize.defects",
  });
  const defectListPagedRowIdsRef = useRef<string[]>([]);
  defectListPagedRowIdsRef.current = defectPager.pagedItems.map((r) => r.id);
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const { onRowCheckboxPointerDown, tableBodyRef: defectListTableBodyRef } =
    useRowCheckboxBrushByIds({
      pagedRowIdsRef: defectListPagedRowIdsRef,
      selectedIdsRef,
      setSelectedIds: setSelectedIds,
    });

  const allDefectListRowIds = useMemo(
    () => visible.map((r) => r.id),
    [visible],
  );

  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    if (selectedIds.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const pageIds = defectPager.pagedItems.map((r) => r.id);
    const selectedSet = new Set(selectedIds);
    const allPageSelected =
      pageIds.length > 0 && pageIds.every((id) => selectedSet.has(id));
    el.indeterminate = !allPageSelected;
    el.checked = allPageSelected;
  }, [defectPager.pagedItems, selectedIds]);

  useEffect(() => {
    const el = selectAllFullVisibleRef.current;
    if (!el) return;
    const ids = allDefectListRowIds;
    if (ids.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const fullSet = new Set(ids);
    const exactAll =
      selectedIds.length === ids.length &&
      selectedIds.every((id) => fullSet.has(id));
    const someInList = ids.some((id) => selectedIds.includes(id));
    el.checked = exactAll;
    el.indeterminate = someInList && !exactAll;
  }, [allDefectListRowIds, selectedIds]);

  const toggleDefectSelectPage = useCallback(() => {
    const ids = defectPager.pagedItems.map((r) => r.id);
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      const pageSet = new Set(ids);
      const allOn = ids.every((id) => prev.includes(id));
      return allOn
        ? prev.filter((id) => !pageSet.has(id))
        : [...new Set([...prev, ...ids])];
    });
  }, [defectPager.pagedItems]);

  const toggleDefectSelectAllVisible = useCallback(() => {
    const ids = allDefectListRowIds;
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      const fullSet = new Set(ids);
      const exact =
        prev.length === ids.length &&
        prev.every((id) => fullSet.has(id));
      if (exact) return [];
      return [...ids];
    });
  }, [allDefectListRowIds]);

  const startResizeCol = useCallback(
    (e: React.MouseEvent, key: DefectColumnKey) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = cols.widthFor(key);
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        cols.setWidth(key, startW + dx);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [cols],
  );

  /** 列宽总和 + 勾选列；避免 table-fixed 下“总宽大于列宽之和”时浏览器把多余宽度均摊，看起来拖不动 */
  const defectListTablePx = useMemo(() => {
    const chk = 56;
    const sum =
      chk + cols.visibleOrdered.reduce((s, k) => s + cols.widthFor(k), 0);
    return Math.max(1100, sum);
  }, [cols.visibleOrdered, cols.config.widths]);

  const renderCell = useCallback(
    (r: DefectListItem, key: DefectColumnKey) => {
      switch (key) {
        case "defectNo":
          return (
            <div className="font-mono text-xs italic text-zinc-500 tabular-nums">
              {r.defectNo}
            </div>
          );
        case "name":
          return (
            <div className="truncate text-sm font-medium text-zinc-900">
              {r.name}
            </div>
          );
        case "status":
          return (
            <span
              className={[
                "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                statusBadgeClass[r.status] ?? "border-zinc-200 bg-white text-zinc-700",
              ].join(" ")}
            >
              {statusLabel[r.status] ?? String(r.status)}
            </span>
          );
        case "severity":
          return (
            <span
              className={[
                "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
                severityBadgeClass[r.severity] ??
                  "border-zinc-200 bg-white text-zinc-700",
              ].join(" ")}
            >
              {severityLabel[r.severity] ?? String(r.severity)}
            </span>
          );
        case "iterationCode":
          return (
            <div className="text-xs text-zinc-600">
              {r.iterationCode
                ? (iterationLabelByCode.get(r.iterationCode) ?? r.iterationCode)
                : "—"}
            </div>
          );
        case "caseNo":
          return <div className="text-xs text-zinc-600">{r.caseNo ?? "—"}</div>;
        case "devOwner":
          return <div className="text-xs text-zinc-600">{r.devOwner ?? "—"}</div>;
        case "submitter":
          return <div className="text-xs text-zinc-600">{r.submitter ?? "—"}</div>;
        case "linkedTestId":
          return (
            <div className="text-xs text-zinc-600">
              {r.linkedTestId
                ? (caseLabelById.get(r.linkedTestId) ?? r.linkedTestId)
                : "—"}
            </div>
          );
        case "linkedProject":
          return (
            <div className="text-xs text-zinc-600">
              {r.linkedProject
                ? (productLabelById.get(r.linkedProject) ?? r.linkedProject)
                : "—"}
            </div>
          );
        case "reopenCount":
          return (
            <div className="text-xs text-zinc-600 tabular-nums">{r.reopenCount ?? 0}</div>
          );
        case "createdAt":
          return (
            <div className="text-xs text-zinc-600 tabular-nums">{formatTs(r.createdAt)}</div>
          );
        case "updatedBy":
          return (
            <div className="text-xs text-zinc-600">{r.updatedBy?.trim() || "—"}</div>
          );
        case "updatedAt":
          return (
            <div className="text-xs text-zinc-600 tabular-nums">
              {formatUpdatedAtTs(r.updatedAt)}
            </div>
          );
        default:
          return <div className="text-xs text-zinc-600">—</div>;
      }
    },
    [caseLabelById, iterationLabelByCode, productLabelById],
  );

  return (
    <>
      <ModuleWorkspaceCard>
        <div className="flex min-h-[70vh] flex-col">
          <div className="border-b border-zinc-100 px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-zinc-900">缺陷列表</h2>
                <p className="mt-0.5 text-xs text-zinc-500">
                  点击缺陷行进入编辑；使用高级筛选定位；可勾选批量删除。
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                <select
                  className="h-8 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm"
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                  title="切换产品后，仅展示该产品迭代"
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code ? `${p.name}（${p.code}）` : p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setAdvOpen((o) => !o)}
                  className={MODULE_TOOLBAR_BTN_SECONDARY}
                  aria-expanded={advOpen}
                >
                  <span>高级筛选</span>{" "}
                  <span className="ml-1 text-xs text-zinc-500">
                    {advOpen ? "▼" : "▶"}
                  </span>
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setColMenuOpen((o) => !o)}
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    title="列表列设置（显隐、顺序；表头可拖竖线调宽）"
                    aria-expanded={colMenuOpen}
                    aria-haspopup="true"
                    aria-label="缺陷列表列设置"
                  >
                    ⚙
                  </button>
                  {colMenuOpen ? (
                    <div className="absolute right-0 top-[calc(100%+8px)] z-20 w-[320px] rounded-xl border border-zinc-200 bg-white p-2 shadow-xl">
                      <div className="px-2 pb-2 text-xs font-medium text-zinc-500">
                        列设置
                      </div>
                      <div className="max-h-[320px] overflow-auto">
                        {cols.config.order.map((k, idx) => (
                          <div
                            key={k}
                            className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50"
                          >
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-zinc-300"
                              checked={cols.config.visible[k] !== false}
                              onChange={(e) => cols.setVisible(k, e.target.checked)}
                            />
                            <div className="flex-1 text-sm text-zinc-800">
                              {DEFECT_COLUMN_LABELS[k]}
                            </div>
                            <button
                              type="button"
                              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                              disabled={idx === 0}
                              onClick={() => cols.moveKey(k, -1)}
                              title="上移"
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-zinc-200 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
                              disabled={idx === cols.config.order.length - 1}
                              onClick={() => cols.moveKey(k, 1)}
                              title="下移"
                            >
                              ↓
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-100 pt-2">
                        <button
                          type="button"
                          className="rounded-lg border border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                          onClick={() => cols.resetDefaults()}
                        >
                          重置默认
                        </button>
                        <button
                          type="button"
                          className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white"
                          onClick={() => setColMenuOpen(false)}
                        >
                          关闭
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={openCreate}
                  className={MODULE_TOOLBAR_BTN_PRIMARY}
                >
                  新建缺陷
                </button>
              </div>
            </div>
          </div>

          <div className="p-4">
            {err ? (
              <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {err}
              </div>
            ) : null}

            {selectedIds.length > 0 ? (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/90 px-3 py-2.5 text-sm text-zinc-800">
                <span>
                  已选{" "}
                  <strong className="tabular-nums">{selectedIds.length}</strong>{" "}
                  条
                </span>
                <button
                  type="button"
                  disabled={batchWorking}
                  className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                  onClick={runBatchDelete}
                >
                  批量删除
                </button>
                <button
                  type="button"
                  className="ml-auto text-xs text-zinc-500 underline hover:text-zinc-800"
                  onClick={() => setSelectedIds([])}
                >
                  取消选择
                </button>
              </div>
            ) : null}

            {advOpen ? (
              <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50/60">
                <div className="border-t border-zinc-200 px-3 pb-3 pt-3">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        关键词
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.q}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, q: e.target.value }))
                        }
                        placeholder="编号/名称/描述/项目/测试ID"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        状态
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.status}
                        onChange={(e) =>
                          setAdv((p) => ({
                            ...p,
                            status: e.target.value as DefectStatus | "",
                          }))
                        }
                      >
                        <option value="">全部</option>
                        {(Object.keys(statusLabel) as DefectStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {statusLabel[s]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        严重等级
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.severity}
                        onChange={(e) =>
                          setAdv((p) => ({
                            ...p,
                            severity: e.target.value as DefectSeverity | "",
                          }))
                        }
                      >
                        <option value="">全部</option>
                        {(Object.keys(severityLabel) as DefectSeverity[]).map(
                          (s) => (
                            <option key={s} value={s}>
                              {severityLabel[s]}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        关联迭代
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.iterationCode}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, iterationCode: e.target.value }))
                        }
                      >
                        {visibleIterationOptions.map((o) => (
                          <option key={o.code || "__baseline__"} value={o.code}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        关联产品
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.linkedProject}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, linkedProject: e.target.value }))
                        }
                      >
                        <option value="">全部</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.code ? `${p.name}（${p.code}）` : p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        用例编号包含
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.caseNo}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, caseNo: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        开发责任人包含
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.devOwner}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, devOwner: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        提交人包含
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.submitter}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, submitter: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        重开次数 ≥
                      </label>
                      <input
                        type="number"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.reopenCountMin}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, reopenCountMin: e.target.value }))
                        }
                        min={0}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        重开次数 ≤
                      </label>
                      <input
                        type="number"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.reopenCountMax}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, reopenCountMax: e.target.value }))
                        }
                        min={0}
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        创建时间从
                      </label>
                      <input
                        type="date"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.createdFrom}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, createdFrom: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        创建时间到
                      </label>
                      <input
                        type="date"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.createdTo}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, createdTo: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        修改人包含
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.updatedBy}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, updatedBy: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        修改时间从
                      </label>
                      <input
                        type="date"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.updatedFrom}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, updatedFrom: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        修改时间到
                      </label>
                      <input
                        type="date"
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm"
                        value={adv.updatedTo}
                        onChange={(e) =>
                          setAdv((p) => ({ ...p, updatedTo: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      onClick={() => setAdv({ ...DEFAULT_ADV })}
                    >
                      重置筛选
                    </button>
                    <button
                      type="button"
                      className="rounded-lg bg-zinc-900 px-3 py-2 text-xs font-medium text-white"
                      onClick={() => void reload()}
                    >
                      应用
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {loading ? (
              <p className="text-sm text-zinc-500">加载中…</p>
            ) : visible.length === 0 ? (
              <p className="text-sm text-zinc-500">暂无缺陷数据。</p>
            ) : (
              <div className="flex flex-col">
                <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                  <table
                    className="table-fixed"
                    style={{
                      width: defectListTablePx,
                      minWidth: defectListTablePx,
                    }}
                  >
                  <colgroup>
                    <col style={{ width: 56 }} />
                    {cols.visibleOrdered.map((k) => (
                      <col key={k} style={{ width: cols.widthFor(k) }} />
                    ))}
                  </colgroup>
                  <thead className="border-b border-zinc-200 bg-zinc-50/80 text-xs text-zinc-500">
                    <tr>
                      <th className="w-16 min-w-[4rem] py-2.5 pr-2 text-left align-bottom font-medium">
                        <div className="flex items-end gap-1">
                          <input
                            ref={selectAllRef}
                            type="checkbox"
                            className="h-4 w-4 shrink-0 rounded border-zinc-300"
                            onChange={toggleDefectSelectPage}
                            title="全选当前页（可与其它页已选合并）"
                            aria-label="全选当前页"
                          />
                          <input
                            ref={selectAllFullVisibleRef}
                            type="checkbox"
                            className="h-4 w-4 shrink-0 rounded border-zinc-300"
                            onChange={toggleDefectSelectAllVisible}
                            title="全选列表：选中当前筛选下全部缺陷（与分页「/ 总数」一致）"
                            aria-label="全选全部可见缺陷"
                          />
                        </div>
                      </th>
                      {cols.visibleOrdered.map((k, idx) => {
                        const w = cols.widthFor(k);
                        const isLast = idx === cols.visibleOrdered.length - 1;
                        return (
                          <th
                            key={k}
                            className={[
                              "relative py-2.5 text-left align-bottom font-medium",
                              isLast ? "pr-3" : "pr-2",
                            ].join(" ")}
                            style={{ width: w, minWidth: w }}
                          >
                            <div className="truncate pr-1">
                              {DEFECT_COLUMN_LABELS[k]}
                            </div>
                            <TableColumnResizeHandle
                              onResizeStart={(e) => startResizeCol(e, k)}
                            />
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody ref={defectListTableBodyRef}>
                    {defectPager.pagedItems.map((r) => (
                      <tr
                        key={r.id}
                        data-pm-row-select={r.id}
                        className="group border-b border-zinc-100 hover:bg-zinc-50/70"
                        onClick={() => openEdit(r)}
                      >
                        <td
                          className="w-16 min-w-[4rem] py-2.5 pr-2 align-top"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-zinc-300"
                            checked={selectedIds.includes(r.id)}
                            onChange={() => {}}
                            onClick={(e) => e.preventDefault()}
                            onPointerDown={(e) =>
                              onRowCheckboxPointerDown(e, r.id)
                            }
                            onKeyDown={(e) => {
                              if (e.key !== " " && e.key !== "Enter") return;
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedIds((prev) =>
                                prev.includes(r.id)
                                  ? prev.filter((x) => x !== r.id)
                                  : [...prev, r.id],
                              );
                            }}
                            title="按住并拖动经过多行可连续勾选"
                          />
                        </td>
                        {cols.visibleOrdered.map((k, idx) => {
                          const w = cols.widthFor(k);
                          const isLast = idx === cols.visibleOrdered.length - 1;
                          const pad = isLast ? "pr-3" : "pr-2";
                          return (
                            <td
                              key={k}
                              className={`py-2.5 align-top ${pad}`}
                              style={{ width: w, minWidth: w }}
                            >
                              {renderCell(r, k)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                  </table>
                </div>
                <div className="shrink-0">
                  <PaginationBar
                    page={defectPager.page}
                    pageCount={defectPager.pageCount}
                    pageSize={defectPager.pageSize}
                    pageSizeOptions={defectPager.pageSizeOptions}
                    rangeLabel={defectPager.rangeLabel}
                    onPageChange={defectPager.setPage}
                    onPageSizeChange={defectPager.setPageSize}
                    className="!mt-0 w-full justify-end pt-3"
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </ModuleWorkspaceCard>

      {editOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/45 p-4">
          <div className="mb-8 flex max-h-[92vh] w-[66.67vw] min-h-[min(70vh,720px)] max-w-[1200px] flex-col rounded-2xl border border-zinc-200 bg-white shadow-xl">
            <div className="shrink-0 border-b border-zinc-100 px-6 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-900">
                    {editId ? "编辑缺陷" : "新建缺陷"}
                  </h3>
                    <div className="mt-2 max-w-[820px]">
                    <input
                      className="w-full rounded-lg border border-transparent bg-transparent px-0 py-0 text-lg font-semibold text-zinc-900 outline-none focus:border-transparent focus:ring-0"
                      value={draft.name}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, name: e.target.value }))
                      }
                      placeholder="缺陷名称"
                    />
                    <div className="mt-1 text-xs text-zinc-500">
                      缺陷编号：{draft.defectNo?.trim() ? draft.defectNo : "（保存后自动生成）"}
                      {createdAtIso ? (
                        <span className="ml-3 tabular-nums">
                          创建时间：{formatTs(createdAtIso)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-sm hover:bg-zinc-50"
                  onClick={() => setEditOpen(false)}
                >
                  关闭
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-4">
              {err ? (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {err}
                </div>
              ) : null}
              <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
                <section className="rounded-xl border border-zinc-200 bg-zinc-50/40 p-4">
                  <div className="flex items-center justify-between gap-2 border-b border-zinc-200/70 pb-2">
                    <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs">
                      <button
                        type="button"
                        className={[
                          "rounded-md px-2.5 py-1 font-medium",
                          editTab === "desc"
                            ? "bg-zinc-900 text-white"
                            : "text-zinc-700 hover:bg-zinc-50",
                        ].join(" ")}
                        onClick={() => setEditTab("desc")}
                      >
                        缺陷描述
                      </button>
                      <button
                        type="button"
                        className={[
                          "rounded-md px-2.5 py-1 font-medium",
                          editTab === "cases"
                            ? "bg-zinc-900 text-white"
                            : "text-zinc-700 hover:bg-zinc-50",
                        ].join(" ")}
                        onClick={() => setEditTab("cases")}
                      >
                        已关联用例
                      </button>
                      <button
                        type="button"
                        className={[
                          "rounded-md px-2.5 py-1 font-medium",
                          editTab === "ops"
                            ? "bg-zinc-900 text-white"
                            : "text-zinc-700 hover:bg-zinc-50",
                        ].join(" ")}
                        onClick={() => setEditTab("ops")}
                      >
                        操作记录
                      </button>
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      {editTab === "desc"
                        ? "保存按钮会保存描述与右侧字段。"
                        : editTab === "cases"
                          ? "关联关系会即时保存。"
                          : "记录包含保存、关联用例等操作。"}
                    </div>
                  </div>

                  {editTab === "desc" ? (
                    <>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[11px] text-zinc-500">
                          可粘贴截图或选择图片，系统会插入到描述中（data URL）。
                        </div>
                        <label className="inline-flex cursor-pointer items-center rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50">
                          + 添加图片
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(e) => void onPickDescImages(e.target.files)}
                          />
                        </label>
                      </div>
                      <textarea
                        ref={descRef}
                        className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        rows={10}
                        value={descText}
                        onChange={(e) => setDescText(e.target.value)}
                        onPaste={(e) => {
                          const items = Array.from(e.clipboardData?.items ?? []);
                          const img = items.find((it) => it.type.startsWith("image/"));
                          if (!img) return;
                          const file = img.getAsFile();
                          if (!file) return;
                          e.preventDefault();
                          void onPickDescImages({
                            0: file,
                            length: 1,
                            item: () => file,
                          } as unknown as FileList);
                        }}
                        placeholder="记录缺陷现象、复现步骤、期望结果、实际结果等（支持 Markdown 图片）"
                      />
                      {descImages.length > 0 ? (
                        <div className="mt-3">
                          <div className="text-xs font-medium text-zinc-600">
                            图片预览
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {descImages.map((x, idx) => (
                              <div
                                key={x.id}
                                className="relative overflow-hidden rounded-lg border border-zinc-200 bg-white"
                              >
                                <button
                                  type="button"
                                  className="absolute right-1 top-1 z-10 flex h-6 w-6 items-center justify-center rounded-md bg-black/55 text-sm font-light leading-none text-white shadow-sm hover:bg-black/70"
                                  title="删除此图"
                                  aria-label="删除此图"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setDescImages((prev) =>
                                      prev.filter((img) => img.id !== x.id),
                                    );
                                  }}
                                >
                                  ×
                                </button>
                                <a
                                  href="#"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setImgPreviewSrc(x.dataUrl);
                                    setImgPreviewOpen(true);
                                  }}
                                  className="group block"
                                  title="点击放大"
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={x.dataUrl}
                                    alt={`截图${idx + 1}`}
                                    className="h-28 w-full object-cover transition group-hover:scale-[1.02]"
                                  />
                                </a>
                              </div>
                            ))}
                          </div>
                          <div className="mt-2 flex justify-end">
                            <button
                              type="button"
                              className="rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                              onClick={() => setDescImages([])}
                            >
                              清空图片
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : editTab === "cases" ? (
                    !editId ? (
                      <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                        请先保存缺陷后再关联用例。
                      </div>
                    ) : (
                      <div className="mt-3 space-y-3">
                        <div className="flex flex-wrap items-end gap-2">
                          <div
                            className="min-w-[260px] flex-1"
                            id="defect-add-link-panel-root"
                          >
                            <label className="text-xs font-medium text-zinc-600">
                              添加关联用例
                            </label>
                            <div className="relative mt-1">
                              <input
                                type="search"
                                className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                                value={addLinkQuery}
                                onChange={(e) => setAddLinkQuery(e.target.value)}
                                onFocus={() => {
                                  setAddLinkPanelOpen(true);
                                  setAddLinkProductId((prev) => prev || productId);
                                }}
                                placeholder="搜索用例（编号/名称）"
                              />
                              {addLinkPanelOpen ? (
                                <div className="absolute left-0 top-[calc(100%+6px)] z-30 w-[min(560px,92vw)] max-w-[90vw] rounded-xl border border-zinc-200 bg-white p-2 shadow-xl">
                                  <div className="flex flex-wrap items-end gap-2">
                                    <div className="min-w-[200px] flex-1">
                                      <label className="text-[11px] font-medium text-zinc-500">
                                        产品
                                      </label>
                                      <select
                                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                                        value={addLinkProductId}
                                        onChange={(e) => {
                                          setAddLinkProductId(e.target.value);
                                          setAddLinkIterCode("");
                                        }}
                                      >
                                        <option value="">
                                          全部产品（不按产品过滤）
                                        </option>
                                        {products.map((p) => (
                                          <option key={p.id} value={p.id}>
                                            {p.code
                                              ? `${p.name}（${p.code}）`
                                              : p.name}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                    <div className="min-w-[200px] flex-1">
                                      <label className="text-[11px] font-medium text-zinc-500">
                                        迭代
                                      </label>
                                      <select
                                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                                        value={addLinkIterCode}
                                        onChange={(e) =>
                                          setAddLinkIterCode(e.target.value)
                                        }
                                      >
                                        {addLinkIterationOptions.map((o) => (
                                          <option
                                            key={o.code || "__baseline__"}
                                            value={o.code}
                                          >
                                            {addLinkProductId.trim() && o.code
                                              ? iterationSelectShortLabel(o)
                                              : o.label}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={
                                        linkBusy ||
                                        addLinkSelectedIds.length === 0
                                      }
                                      className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                                      onClick={() => void addLink()}
                                    >
                                      {addLinkSelectedIds.length > 0
                                        ? `添加已选（${addLinkSelectedIds.length}）`
                                        : "添加"}
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded-lg border border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                                      onClick={() => {
                                        setAddLinkProductId(productId);
                                        setAddLinkIterCode("");
                                        setAddLinkQuery("");
                                        setAddLinkSelectedIds([]);
                                      }}
                                    >
                                      重置
                                    </button>
                                  </div>

                                  <div className="mt-2 rounded-lg border border-zinc-200">
                                    <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
                                      <span>搜索结果（最多 20 条）</span>
                                      <span>{addLinkLoading ? "加载中…" : ""}</span>
                                    </div>
                                    <div className="max-h-[320px] overflow-auto">
                                      {addLinkResults.length === 0 ? (
                                        <div className="px-3 py-3 text-sm text-zinc-500">
                                          {addLinkLoading
                                            ? "加载中…"
                                            : "暂无结果"}
                                        </div>
                                      ) : (
                                        <table className="w-full min-w-[360px] table-fixed text-sm">
                                          <colgroup>
                                            <col style={{ width: addLinkTblChkW }} />
                                            <col style={{ width: addLinkTblNoW }} />
                                            <col />
                                          </colgroup>
                                          <thead className="sticky top-0 z-[1] border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                                            <tr>
                                              <th
                                                scope="col"
                                                className="relative px-2 py-2 text-left font-medium"
                                              >
                                                <input
                                                  ref={addLinkSelectAllRef}
                                                  type="checkbox"
                                                  className="h-3.5 w-3.5 rounded border-zinc-300"
                                                  aria-label="全选当前搜索结果"
                                                  onChange={() =>
                                                    toggleAddLinkPickAll()
                                                  }
                                                />
                                                <TableColumnResizeHandle
                                                  onResizeStart={
                                                    startResizeAddLinkChkVsNo
                                                  }
                                                />
                                              </th>
                                              <th
                                                scope="col"
                                                className="relative px-2 py-2 text-left font-medium"
                                              >
                                                编号
                                                <TableColumnResizeHandle
                                                  onResizeStart={
                                                    startResizeAddLinkNoVsTitle
                                                  }
                                                />
                                              </th>
                                              <th
                                                scope="col"
                                                className="px-2 py-2 text-left font-medium"
                                              >
                                                名称
                                              </th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-zinc-100">
                                            {addLinkResults.map((c) => (
                                              <tr
                                                key={c.id}
                                                className="hover:bg-zinc-50/70"
                                              >
                                                <td className="px-2 py-2 align-middle">
                                                  <input
                                                    type="checkbox"
                                                    className="h-3.5 w-3.5 rounded border-zinc-300"
                                                    checked={
                                                      linkedCaseIdSetForAddPanel.has(
                                                        c.id,
                                                      ) || addLinkPickSet.has(c.id)
                                                    }
                                                    disabled={linkedCaseIdSetForAddPanel.has(
                                                      c.id,
                                                    )}
                                                    aria-label={`选择用例 ${c.caseNo}`}
                                                    onChange={() => {
                                                      if (
                                                        linkedCaseIdSetForAddPanel.has(
                                                          c.id,
                                                        )
                                                      )
                                                        return;
                                                      toggleAddLinkPick(c.id);
                                                    }}
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                  />
                                                </td>
                                                <td className="px-2 py-2 font-mono text-xs text-zinc-700">
                                                  {c.caseNo}
                                                </td>
                                                <td className="px-2 py-2 text-zinc-800">
                                                  <div className="truncate">
                                                    {c.title}
                                                  </div>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                            {addLinkSelectedIds.length > 0 ? (
                              <div className="mt-1 text-[11px] text-zinc-500">
                                已选 {addLinkSelectedIds.length} 条
                                {(() => {
                                  const byId = new Map(
                                    addLinkResults.map((x) => [x.id, x]),
                                  );
                                  const labels = addLinkSelectedIds
                                    .map(
                                      (id) =>
                                        byId.get(id)?.caseNo ??
                                        caseLabelById.get(id) ??
                                        id,
                                    )
                                    .slice(0, 5);
                                  const more =
                                    addLinkSelectedIds.length - labels.length;
                                  return (
                                    <span className="text-zinc-400">
                                      {" "}
                                      · {labels.join("、")}
                                      {more > 0 ? ` 等` : ""}
                                    </span>
                                  );
                                })()}
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            disabled={linkBusy || selectedLinkIds.length === 0}
                            className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
                            onClick={() => void removeLinks(selectedLinkIds)}
                          >
                            批量移除
                          </button>
                        </div>

                        <div className="rounded-lg border border-zinc-200 bg-white">
                          <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2">
                            <div className="text-xs font-medium text-zinc-600">
                              已关联 {linkedCases.length} 条
                            </div>
                            <div className="text-xs text-zinc-500">
                              可通过“批量移除”后再添加来调整关联。
                            </div>
                          </div>
                          <div className="max-h-[360px] overflow-auto">
                            {linkedCases.length === 0 ? (
                              <div className="px-3 py-3 text-sm text-zinc-500">
                                暂无关联用例。
                              </div>
                            ) : (
                              <table className="w-full min-w-[520px] table-fixed text-sm">
                                <colgroup>
                                  <col style={{ width: linkedCaseTblChkW }} />
                                  <col style={{ width: linkedCaseTblNoW }} />
                                  <col style={{ width: linkedCaseTblTitleW }} />
                                  <col style={{ width: 72 }} />
                                </colgroup>
                                <thead className="bg-zinc-50 text-xs text-zinc-500">
                                  <tr>
                                    <th className="relative px-3 py-2 text-left">
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 rounded border-zinc-300"
                                        checked={
                                          selectedLinkIds.length > 0 &&
                                          selectedLinkIds.length ===
                                            linkedCases.length
                                        }
                                        onChange={() => {
                                          const all = linkedCases.map(
                                            (x) => x.id,
                                          );
                                          const set = new Set(selectedLinkIds);
                                          const allSelected =
                                            all.length > 0 &&
                                            all.every((id) => set.has(id));
                                          setSelectedLinkIds(
                                            allSelected ? [] : all,
                                          );
                                        }}
                                      />
                                      <TableColumnResizeHandle
                                        onResizeStart={startResizeLinkedChkVsNo}
                                      />
                                    </th>
                                    <th className="relative px-3 py-2 text-left">
                                      用例编号
                                      <TableColumnResizeHandle
                                        onResizeStart={
                                          startResizeLinkedNoVsTitle
                                        }
                                      />
                                    </th>
                                    <th className="relative px-3 py-2 text-left">
                                      用例名称
                                      <TableColumnResizeHandle
                                        onResizeStart={
                                          startResizeLinkedTitleVsOp
                                        }
                                      />
                                    </th>
                                    <th className="px-3 py-2 text-right">
                                      操作
                                    </th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-100">
                                  {linkedCases.map((c) => (
                                    <tr
                                      key={c.id}
                                      className="hover:bg-zinc-50/70"
                                    >
                                      <td className="px-3 py-2 align-top">
                                        <input
                                          type="checkbox"
                                          className="mt-0.5 h-4 w-4 rounded border-zinc-300"
                                          checked={selectedLinkIds.includes(
                                            c.id,
                                          )}
                                          onChange={() =>
                                            setSelectedLinkIds((prev) =>
                                              prev.includes(c.id)
                                                ? prev.filter(
                                                    (x) => x !== c.id,
                                                  )
                                                : [...prev, c.id],
                                            )
                                          }
                                        />
                                      </td>
                                      <td className="px-3 py-2 align-top font-mono text-xs text-zinc-700">
                                        {c.caseNo}
                                      </td>
                                      <td className="px-3 py-2 align-top text-zinc-800">
                                        <div className="truncate">
                                          {c.title}
                                        </div>
                                      </td>
                                      <td className="px-3 py-2 text-right align-top">
                                        <button
                                          type="button"
                                          disabled={linkBusy}
                                          className="rounded-md border border-red-200 bg-white px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                                          onClick={() =>
                                            void removeLinks([c.id])
                                          }
                                        >
                                          移除
                                        </button>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="mt-3 rounded-lg border border-zinc-200 bg-white">
                      <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600">
                        操作记录（最近 {opLogs.length} 条）
                      </div>
                      <div className="max-h-[520px] overflow-auto">
                        {opLogs.length === 0 ? (
                          <div className="px-3 py-3 text-sm text-zinc-500">
                            暂无记录。
                          </div>
                        ) : (
                          <table className="w-full table-fixed text-sm">
                            <thead className="bg-zinc-50 text-xs text-zinc-500">
                              <tr>
                                <th className="w-40 px-3 py-2 text-left">时间</th>
                                <th className="w-40 px-3 py-2 text-left">动作</th>
                                <th className="px-3 py-2 text-left">说明</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-100">
                              {opLogs.map((x) => (
                                <tr key={x.id} className="hover:bg-zinc-50/70">
                                  <td className="px-3 py-2 align-top text-xs text-zinc-600 tabular-nums">
                                    {formatTs(x.createdAt)}
                                  </td>
                                  <td className="px-3 py-2 align-top font-mono text-[11px] text-zinc-600">
                                    {x.action}
                                  </td>
                                  <td className="max-w-0 px-3 py-2 align-top whitespace-pre-wrap break-words text-xs text-zinc-700">
                                    {x.detail ?? "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>
                  )}
                </section>

                <section className="rounded-xl border border-transparent bg-transparent p-0">
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        关联产品
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={draft.linkedProject}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            linkedProject: e.target.value,
                          }))
                        }
                      >
                        <option value="">—</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.code ? `${p.name}（${p.code}）` : p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        关联迭代
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={draft.iterationCode}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            iterationCode: e.target.value,
                          }))
                        }
                        title="选择缺陷归属迭代（可用于后续筛选/统计）"
                      >
                        {visibleIterationOptions.map((o) => (
                          <option key={o.code || "__baseline__"} value={o.code}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        状态
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={draft.status}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            status: e.target.value as DefectStatus,
                          }))
                        }
                      >
                        {(Object.keys(statusLabel) as DefectStatus[]).map((s) => (
                          <option key={s} value={s}>
                            {statusLabel[s]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        严重等级
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={draft.severity}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            severity: e.target.value as DefectSeverity,
                          }))
                        }
                      >
                        {(Object.keys(severityLabel) as DefectSeverity[]).map((s) => (
                          <option key={s} value={s}>
                            {severityLabel[s]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        开发责任人
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={draft.devOwner}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, devOwner: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        提交人
                      </label>
                      <input
                        type="text"
                        readOnly
                        disabled
                        tabIndex={-1}
                        className="mt-1 w-full cursor-not-allowed rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-600"
                        value={draft.submitter}
                        placeholder="（不可修改）"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        创建时间
                      </label>
                      <input
                        type="text"
                        readOnly
                        disabled
                        tabIndex={-1}
                        className="mt-1 w-full cursor-not-allowed rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-600 tabular-nums"
                        value={
                          createdAtIso
                            ? formatTs(createdAtIso)
                            : editId
                              ? "—"
                              : "保存后自动生成"
                        }
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        修改人
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                        value={draft.updatedBy}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, updatedBy: e.target.value }))
                        }
                        placeholder="本次保存时记录"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        修改时间
                      </label>
                      <input
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-600"
                        value={
                          lastUpdatedAtIso
                            ? formatUpdatedAtTs(lastUpdatedAtIso)
                            : editId
                              ? "—"
                              : "保存后自动生成"
                        }
                        readOnly
                        disabled
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-zinc-600">
                        缺陷重开次数
                      </label>
                      <input
                        type="text"
                        readOnly
                        disabled
                        tabIndex={-1}
                        title="状态从「已关闭」变为「重开」并保存时自动 +1"
                        className="mt-1 w-full cursor-not-allowed rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm tabular-nums text-zinc-600"
                        value={draft.reopenCount}
                      />
                    </div>
                  </div>
                </section>
              </div>
            </div>

            <div className="shrink-0 border-t border-zinc-100 px-6 py-4">
              <div className="flex items-center justify-between gap-2">
                <span />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50"
                    onClick={() => setEditOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={saveBusy}
                    className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                    onClick={runSave}
                  >
                    {saveBusy ? "保存中…" : "保存"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {imgPreviewOpen && imgPreviewSrc ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          role="dialog"
          aria-modal
          onClick={() => {
            setImgPreviewOpen(false);
            setImgPreviewSrc(null);
          }}
        >
          <div
            className="max-h-[92vh] max-w-[92vw] overflow-auto rounded-xl border border-white/10 bg-black/20 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgPreviewSrc}
              alt="预览"
              className="max-h-[88vh] max-w-[88vw] object-contain"
            />
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                className="rounded-lg bg-white/90 px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-white"
                onClick={() => {
                  setImgPreviewOpen(false);
                  setImgPreviewSrc(null);
                }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

