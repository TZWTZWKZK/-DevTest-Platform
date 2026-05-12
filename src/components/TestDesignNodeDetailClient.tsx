"use client";

import type { TestDesignType } from "@prisma/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { listIterationCodeOptions } from "@/app/actions/iterations";
import {
  searchTestCaseIdOptions,
  type TestCaseIdOption,
} from "@/app/actions/test-cases";
import {
  setTestDesignLinkedCases,
  updateTestDesignNode,
  type ActionResult,
  type TestDesignOpLogRow,
} from "@/app/actions/test-design";
import { CaseLevelSelect } from "@/components/CaseLevelSelect";
import { ModuleWorkspaceCard } from "@/components/PageModuleLayout";
import {
  caseLevelToFormValue,
  parseCaseLevelOrNull,
} from "@/lib/case-level";
import { TableColumnResizeHandle } from "@/components/TableColumnResizeHandle";
import { testDesignTypeLabel, testDesignTypeOptions } from "@/lib/test-labels";

function formatOpTs(iso: string): string {
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

export type PickerCase = {
  id: string;
  caseNo: string;
  title: string;
  folder: { name: string };
};

export function TestDesignNodeDetailClient({
  nodeId,
  pickerProductId,
  backToTreeContext,
  breadcrumb,
  initialTitle,
  initialDescription,
  initialPrecondition,
  initialOperationSteps,
  initialExpectedResult,
  initialRemark,
  initialType,
  initialCaseLevel,
  pickerCases,
  initialLinkedIds,
  initialOpLogs,
}: {
  nodeId: string;
  /** 关联用例搜索范围：与需求所属迭代的产品用例库一致 */
  pickerProductId: string;
  /** 返回树页时恢复产品、迭代与需求节点（与 ModuleWorkspaceCard 下拉一致） */
  backToTreeContext?: {
    productId: string;
    iterationCode: string;
    requirementId: string;
  };
  breadcrumb: string;
  initialTitle: string;
  initialDescription: string | null;
  initialPrecondition: string | null;
  initialOperationSteps: string | null;
  initialExpectedResult: string | null;
  initialRemark: string | null;
  initialType: TestDesignType;
  initialCaseLevel?: number | null;
  pickerCases: PickerCase[];
  initialLinkedIds: string[];
  initialOpLogs: TestDesignOpLogRow[];
}) {
  const router = useRouter();
  const backToTreeHref = useMemo(() => {
    if (!backToTreeContext) return "/test-design";
    const q = new URLSearchParams({
      productId: backToTreeContext.productId,
      iterationCode: backToTreeContext.iterationCode,
      requirementId: backToTreeContext.requirementId,
    });
    return `/test-design?${q.toString()}`;
  }, [backToTreeContext]);
  const [detailTab, setDetailTab] = useState<"basic" | "cases" | "ops">("basic");
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription ?? "");
  const [precondition, setPrecondition] = useState(initialPrecondition ?? "");
  const [operationSteps, setOperationSteps] = useState(
    initialOperationSteps ?? "",
  );
  const [expectedResult, setExpectedResult] = useState(
    initialExpectedResult ?? "",
  );
  const [remark, setRemark] = useState(initialRemark ?? "");
  const [type, setType] = useState<TestDesignType>(initialType);
  const [caseLevel, setCaseLevel] = useState(() =>
    caseLevelToFormValue(initialCaseLevel ?? null),
  );
  useEffect(() => {
    setCaseLevel(caseLevelToFormValue(initialCaseLevel ?? null));
  }, [initialCaseLevel]);
  const [linked, setLinked] = useState<Set<string>>(
    () => new Set(initialLinkedIds),
  );
  const [caseLinkIterCode, setCaseLinkIterCode] = useState("");
  const [caseLinkQuery, setCaseLinkQuery] = useState("");
  const [caseLinkResults, setCaseLinkResults] = useState<TestCaseIdOption[]>(
    [],
  );
  const [caseLinkLoading, setCaseLinkLoading] = useState(false);
  const [iterationOptions, setIterationOptions] = useState<
    { code: string; label: string }[]
  >([{ code: "", label: "baseline（全部迭代）" }]);
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [savingMeta, setSavingMeta] = useState(false);
  const [savingLinks, setSavingLinks] = useState(false);
  const [savedToastOpen, setSavedToastOpen] = useState(false);
  const savedToastTimerRef = useRef<number | null>(null);
  const [linkedCasePickIds, setLinkedCasePickIds] = useState<string[]>([]);
  const linkedCaseSelectAllRef = useRef<HTMLInputElement>(null);
  const [pendingLinkPickIds, setPendingLinkPickIds] = useState<string[]>([]);
  const pendingLinkSelectAllRef = useRef<HTMLInputElement>(null);
  /** 可选用例表：复选列固定 40px，编号列宽 = 本值 − 40 */
  const [pendingPickLeftBlockW, setPendingPickLeftBlockW] = useState(168);
  /** 已关联用例表列宽 */
  const [linkedTblChkW, setLinkedTblChkW] = useState(40);
  const [linkedTblNoW, setLinkedTblNoW] = useState(120);
  const [linkedTblTitleW, setLinkedTblTitleW] = useState(200);
  const [linkedTblFolderW, setLinkedTblFolderW] = useState(128);
  // 左侧导航区已移除：保留详情页专注编辑

  useEffect(() => {
    void (async () => {
      try {
        const opts = await listIterationCodeOptions();
        setIterationOptions(opts);
      } catch {
        // ignore
      }
    })();
  }, []);

  useEffect(() => {
    if (detailTab !== "cases") return;
    const t = window.setTimeout(() => {
      void (async () => {
        setCaseLinkLoading(true);
        try {
          const rows = await searchTestCaseIdOptions({
            q: caseLinkQuery,
            iterationCode: caseLinkIterCode || null,
            take: 200,
            productId: pickerProductId,
          });
          setCaseLinkResults(rows);
        } finally {
          setCaseLinkLoading(false);
        }
      })();
    }, 220);
    return () => clearTimeout(t);
  }, [caseLinkIterCode, caseLinkQuery, detailTab, pickerProductId]);

  const linkedCaseRows = useMemo(
    () => pickerCases.filter((c) => linked.has(c.id)),
    [pickerCases, linked],
  );

  const pendingLinkRows = useMemo(
    () => caseLinkResults.filter((c) => !linked.has(c.id)),
    [caseLinkResults, linked],
  );

  const pendingLinkPickSet = useMemo(
    () => new Set(pendingLinkPickIds),
    [pendingLinkPickIds],
  );

  const pendingLinkPickKey = useMemo(
    () => pendingLinkRows.map((c) => c.id).join("\0"),
    [pendingLinkRows],
  );

  useEffect(() => {
    setPendingLinkPickIds([]);
  }, [pendingLinkPickKey]);

  useEffect(() => {
    const el = pendingLinkSelectAllRef.current;
    if (!el) return;
    if (pendingLinkRows.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const all = pendingLinkRows.every((c) => pendingLinkPickSet.has(c.id));
    const some = pendingLinkRows.some((c) => pendingLinkPickSet.has(c.id));
    el.indeterminate = some && !all;
    el.checked = all;
  }, [pendingLinkPickSet, pendingLinkRows]);

  const togglePendingLinkPick = useCallback((id: string) => {
    setPendingLinkPickIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return Array.from(s);
    });
  }, []);

  const togglePendingLinkPickAll = useCallback(() => {
    const ids = pendingLinkRows.map((c) => c.id);
    const all =
      ids.length > 0 && ids.every((id) => pendingLinkPickSet.has(id));
    setPendingLinkPickIds(all ? [] : ids);
  }, [pendingLinkPickSet, pendingLinkRows]);

  const startResizePendingNoVsTitle = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const w0 = pendingPickLeftBlockW;
    const move = (ev: globalThis.MouseEvent) => {
      const dx = ev.clientX - sx;
      setPendingPickLeftBlockW(
        Math.min(40 + 560, Math.max(40 + 72, w0 + dx)),
      );
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [pendingPickLeftBlockW]);

  const startResizeLinkedChkVsNo = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = linkedTblChkW;
      const b0 = linkedTblNoW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setLinkedTblChkW(Math.min(52, Math.max(32, a0 + dx)));
        setLinkedTblNoW(Math.min(400, Math.max(72, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [linkedTblChkW, linkedTblNoW],
  );

  const startResizeLinkedNoVsTitle = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = linkedTblNoW;
      const b0 = linkedTblTitleW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setLinkedTblNoW(Math.min(400, Math.max(72, a0 + dx)));
        setLinkedTblTitleW(Math.min(720, Math.max(100, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [linkedTblNoW, linkedTblTitleW],
  );

  const startResizeLinkedTitleVsFolder = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = linkedTblTitleW;
      const b0 = linkedTblFolderW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setLinkedTblTitleW(Math.min(720, Math.max(100, a0 + dx)));
        setLinkedTblFolderW(Math.min(480, Math.max(72, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [linkedTblTitleW, linkedTblFolderW],
  );

  const startResizeLinkedFolderVsOp = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const sx = e.clientX;
      const a0 = linkedTblFolderW;
      const b0 = linkedTblTitleW;
      const move = (ev: globalThis.MouseEvent) => {
        const dx = ev.clientX - sx;
        setLinkedTblFolderW(Math.min(480, Math.max(72, a0 + dx)));
        setLinkedTblTitleW(Math.min(720, Math.max(100, b0 - dx)));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [linkedTblFolderW, linkedTblTitleW],
  );

  const addSelectedPendingToLinked = useCallback(() => {
    const ids = pendingLinkPickIds.filter((id) =>
      pendingLinkRows.some((c) => c.id === id),
    );
    if (ids.length === 0) return;
    setMsg(null);
    setLinked((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    setPendingLinkPickIds([]);
  }, [pendingLinkPickIds, pendingLinkRows]);

  const linkedCasePickSet = useMemo(
    () => new Set(linkedCasePickIds),
    [linkedCasePickIds],
  );

  useEffect(() => {
    setLinkedCasePickIds((prev) =>
      prev.filter((id) => linkedCaseRows.some((c) => c.id === id)),
    );
  }, [linkedCaseRows]);

  useEffect(() => {
    const el = linkedCaseSelectAllRef.current;
    if (!el) return;
    if (linkedCaseRows.length === 0) {
      el.indeterminate = false;
      el.checked = false;
      return;
    }
    const all = linkedCaseRows.every((c) => linkedCasePickSet.has(c.id));
    const some = linkedCaseRows.some((c) => linkedCasePickSet.has(c.id));
    el.indeterminate = some && !all;
    el.checked = all;
  }, [linkedCasePickSet, linkedCaseRows]);

  const toggleLinkedCasePick = useCallback((id: string) => {
    setLinkedCasePickIds((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return Array.from(s);
    });
  }, []);

  const toggleLinkedCasePickAll = useCallback(() => {
    const ids = linkedCaseRows.map((c) => c.id);
    const all =
      ids.length > 0 && ids.every((id) => linkedCasePickSet.has(id));
    setLinkedCasePickIds(all ? [] : ids);
  }, [linkedCasePickSet, linkedCaseRows]);

  const removeSelectedLinkedCases = () => {
    if (linkedCasePickIds.length === 0) return;
    if (
      !window.confirm(`从关联列表移除已选 ${linkedCasePickIds.length} 条？保存关联后生效。`)
    ) {
      return;
    }
    setMessageClear();
    setLinked((prev) => {
      const next = new Set(prev);
      for (const id of linkedCasePickIds) next.delete(id);
      return next;
    });
    setLinkedCasePickIds([]);
  };

  const setMessageClear = () => setMsg(null);

  const showSavedToast = useCallback(() => {
    if (savedToastTimerRef.current !== null) {
      window.clearTimeout(savedToastTimerRef.current);
      savedToastTimerRef.current = null;
    }
    setSavedToastOpen(true);
    savedToastTimerRef.current = window.setTimeout(() => {
      setSavedToastOpen(false);
      savedToastTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (savedToastTimerRef.current !== null) {
        window.clearTimeout(savedToastTimerRef.current);
        savedToastTimerRef.current = null;
      }
    };
  }, []);

  const removeCaseFromLinked = (id: string) => {
    setMessageClear();
    setLinked((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const saveMeta = async () => {
    setSavingMeta(true);
    setMsg(null);
    const r = await updateTestDesignNode({
      id: nodeId,
      title,
      description: description.trim() || null,
      precondition: precondition.trim() || null,
      operationSteps: operationSteps.trim() || null,
      expectedResult: expectedResult.trim() || null,
      remark: remark.trim() || null,
      type,
      caseLevel:
        caseLevel.trim() === ""
          ? null
          : parseCaseLevelOrNull(Number.parseInt(caseLevel, 10)),
    });
    setSavingMeta(false);
    if (r.ok) {
      setMsg(null);
      showSavedToast();
    } else {
      setMsg(r);
    }
    if (r.ok) router.refresh();
  };

  const saveLinks = async () => {
    setSavingLinks(true);
    setMsg(null);
    const r = await setTestDesignLinkedCases(nodeId, [...linked]);
    setSavingLinks(false);
    if (r.ok) {
      setMsg(null);
      showSavedToast();
    } else {
      setMsg(r);
    }
    if (r.ok) router.refresh();
  };

  return (
    <ModuleWorkspaceCard>
      <div className="flex min-h-[70vh] flex-col">
        <section className="min-w-0 flex-1 bg-white">
          {savedToastOpen ? (
            <div className="pointer-events-none fixed left-0 right-0 top-0 z-50">
              <div className="mx-auto w-full border-b border-emerald-200 bg-emerald-50/95 px-4 py-3 text-center text-xl font-semibold leading-tight text-emerald-800 shadow-sm backdrop-blur">
                已保存
              </div>
            </div>
          ) : null}
          <div className="border-b border-zinc-100 px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              {detailTab === "basic" ? (
                <div className="min-w-0 flex-1">
                  <input
                    className={[
                      "w-full rounded-lg bg-transparent px-0 py-1 text-xl font-semibold leading-tight text-zinc-900",
                      "border-0 outline-none ring-0",
                      "focus-visible:outline-none focus-visible:ring-0",
                      "focus-visible:underline focus-visible:decoration-zinc-300 focus-visible:underline-offset-4",
                      "placeholder:text-zinc-400",
                    ].join(" ")}
                    value={title}
                    placeholder="标题"
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setMessageClear();
                    }}
                  />
                </div>
              ) : (
                <h2 className="text-sm font-semibold text-zinc-900">节点编辑</h2>
              )}
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">
              使用下列标签切换基本信息、关联用例与操作记录。
            </p>
          </div>
          <div className="space-y-4 px-4 py-4">
            {msg?.error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {msg.error}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3">
              <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs">
                <button
                  type="button"
                  className={[
                    "rounded-md px-2.5 py-1 font-medium",
                    detailTab === "basic"
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-700 hover:bg-zinc-50",
                  ].join(" ")}
                  onClick={() => setDetailTab("basic")}
                >
                  基本信息
                </button>
                <button
                  type="button"
                  className={[
                    "rounded-md px-2.5 py-1 font-medium",
                    detailTab === "cases"
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-700 hover:bg-zinc-50",
                  ].join(" ")}
                  onClick={() => setDetailTab("cases")}
                >
                  关联用例
                </button>
                <button
                  type="button"
                  className={[
                    "rounded-md px-2.5 py-1 font-medium",
                    detailTab === "ops"
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-700 hover:bg-zinc-50",
                  ].join(" ")}
                  onClick={() => setDetailTab("ops")}
                >
                  操作记录
                </button>
              </div>
              <div className="text-[11px] text-zinc-500">
                {detailTab === "basic"
                  ? "编辑标题、类型与正文后保存基本信息。"
                  : detailTab === "cases"
                    ? "勾选用例后保存关联；导入到用例库也会写入关联。"
                    : `最近 ${initialOpLogs.length} 条（服务端分页 12 条）`}
              </div>
            </div>

            {detailTab === "basic" ? (
            <div className="space-y-4 pb-4">
              <section className="rounded-xl bg-zinc-50/40 p-4">
                <div className="grid gap-2 sm:grid-cols-2 sm:gap-x-2 sm:gap-y-2">
                  <div className="sm:col-span-2">
                    <label className="text-xs font-medium text-zinc-600">描述</label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        setMessageClear();
                      }}
                      placeholder="可选：一句话概述/说明"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      用例等级
                    </label>
                    <CaseLevelSelect
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      value={caseLevel}
                      onChange={(v) => {
                        setCaseLevel(v);
                        setMessageClear();
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">类型</label>
                    <select
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      value={type}
                      onChange={(e) => {
                        setType(e.target.value as TestDesignType);
                        setMessageClear();
                      }}
                    >
                      {testDesignTypeOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-zinc-500">
                      当前：{testDesignTypeLabel[type]}
                    </p>
                  </div>
                  <section className="rounded-xl bg-zinc-50/40 p-4 sm:col-span-2 min-h-[520px]">
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          前置条件
                        </label>
                        <textarea
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                          rows={8}
                          value={precondition}
                          onChange={(e) => {
                            setPrecondition(e.target.value);
                            setMessageClear();
                          }}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          操作步骤
                        </label>
                        <textarea
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                          rows={8}
                          value={operationSteps}
                          onChange={(e) => {
                            setOperationSteps(e.target.value);
                            setMessageClear();
                          }}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          预期结果
                        </label>
                        <textarea
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                          rows={8}
                          value={expectedResult}
                          onChange={(e) => {
                            setExpectedResult(e.target.value);
                            setMessageClear();
                          }}
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-zinc-600">
                          备注
                        </label>
                        <textarea
                          className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                          rows={8}
                          value={remark}
                          onChange={(e) => {
                            setRemark(e.target.value);
                            setMessageClear();
                          }}
                        />
                      </div>
                    </div>
                  </section>
                  <div className="sm:col-span-2 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      disabled={savingMeta}
                      onClick={saveMeta}
                      className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                    >
                      {savingMeta ? "保存中…" : "保存基本信息"}
                    </button>
                    <Link
                      href={backToTreeHref}
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                    >
                      返回测试设计树
                    </Link>
                  </div>
                </div>
              </section>
            </div>
            ) : detailTab === "cases" ? (
            <div className="space-y-6 pb-4">
              <div className="rounded-lg border border-zinc-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2">
                  <div className="text-xs font-medium text-zinc-600">
                    已关联用例（{linkedCaseRows.length} 条）
                  </div>
                  {linkedCaseRows.length > 0 ? (
                    <button
                      type="button"
                      disabled={linkedCasePickIds.length === 0}
                      className="rounded-lg border border-red-200 bg-white px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                      onClick={removeSelectedLinkedCases}
                    >
                      {linkedCasePickIds.length > 0
                        ? `批量移除（${linkedCasePickIds.length}）`
                        : "批量移除"}
                    </button>
                  ) : null}
                </div>
                <div className="max-h-64 overflow-auto">
                  {linkedCaseRows.length === 0 ? (
                    <p className="p-4 text-sm text-zinc-500">
                      尚未关联用例。请在下方「待关联用例」中搜索并添加，或通过「导入到用例库」自动关联。
                    </p>
                  ) : (
                    <table className="w-full min-w-[640px] table-fixed text-sm">
                      <colgroup>
                        <col style={{ width: linkedTblChkW }} />
                        <col style={{ width: linkedTblNoW }} />
                        <col style={{ width: linkedTblTitleW }} />
                        <col style={{ width: linkedTblFolderW }} />
                        <col style={{ width: 72 }} />
                      </colgroup>
                      <thead className="bg-zinc-50 text-xs text-zinc-500">
                        <tr>
                          <th className="relative px-2 py-2 text-left">
                            <input
                              ref={linkedCaseSelectAllRef}
                              type="checkbox"
                              className="h-3.5 w-3.5 rounded border-zinc-300"
                              aria-label="全选已关联用例"
                              onChange={() => toggleLinkedCasePickAll()}
                            />
                            <TableColumnResizeHandle
                              onResizeStart={startResizeLinkedChkVsNo}
                            />
                          </th>
                          <th className="relative px-3 py-2 text-left">
                            用例编号
                            <TableColumnResizeHandle
                              onResizeStart={startResizeLinkedNoVsTitle}
                            />
                          </th>
                          <th className="relative px-3 py-2 text-left">
                            名称
                            <TableColumnResizeHandle
                              onResizeStart={startResizeLinkedTitleVsFolder}
                            />
                          </th>
                          <th className="relative px-3 py-2 text-left">
                            文件夹
                            <TableColumnResizeHandle
                              onResizeStart={startResizeLinkedFolderVsOp}
                            />
                          </th>
                          <th className="px-3 py-2 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-100">
                        {linkedCaseRows.map((c) => (
                          <tr key={c.id} className="hover:bg-zinc-50/70">
                            <td className="px-2 py-2 align-top">
                              <input
                                type="checkbox"
                                className="h-3.5 w-3.5 rounded border-zinc-300"
                                checked={linkedCasePickSet.has(c.id)}
                                aria-label={`选择用例 ${c.caseNo}`}
                                onChange={() => toggleLinkedCasePick(c.id)}
                              />
                            </td>
                            <td className="px-3 py-2 align-top font-mono text-xs text-zinc-700">
                              {c.caseNo}
                            </td>
                            <td className="max-w-0 px-3 py-2 align-top text-zinc-800">
                              <div className="truncate" title={c.title}>
                                {c.title}
                              </div>
                            </td>
                            <td className="max-w-0 px-3 py-2 align-top text-xs text-zinc-500">
                              <span className="line-clamp-2 break-words">
                                {c.folder.name}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right align-top">
                              <button
                                type="button"
                                className="text-xs text-red-700 hover:underline"
                                onClick={() => removeCaseFromLinked(c.id)}
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

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  待关联用例
                </h4>
                <p className="mt-1 text-xs text-zinc-500">
                  选择迭代后，下方列出可选的用例；可勾选多行后点「加入已选」加入上表，再点「保存关联」写入服务端。
                </p>
                <div
                  className="mt-3 space-y-3"
                  id="test-design-add-case-panel-root"
                >
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[220px] flex-1">
                      <label className="text-[11px] font-medium text-zinc-500">
                        迭代筛选
                      </label>
                      <select
                        className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm"
                        value={caseLinkIterCode}
                        onChange={(e) => setCaseLinkIterCode(e.target.value)}
                      >
                        {iterationOptions.map((o) => (
                          <option
                            key={o.code || "__baseline__"}
                            value={o.code}
                          >
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      disabled={savingLinks}
                      onClick={saveLinks}
                      className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                    >
                      {savingLinks ? "保存中…" : "保存关联"}
                    </button>
                    <button
                      type="button"
                      disabled={pendingLinkPickIds.length === 0}
                      className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-white disabled:opacity-50"
                      onClick={addSelectedPendingToLinked}
                    >
                      {pendingLinkPickIds.length > 0
                        ? `加入已选（${pendingLinkPickIds.length}）`
                        : "加入已选"}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-200 px-2.5 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
                      onClick={() => {
                        setCaseLinkIterCode("");
                        setCaseLinkQuery("");
                        setPendingLinkPickIds([]);
                      }}
                    >
                      重置
                    </button>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      搜索用例
                    </label>
                    <input
                      type="search"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      value={caseLinkQuery}
                      onChange={(e) => setCaseLinkQuery(e.target.value)}
                      placeholder="编号 / 名称（可选）；留空则列出当前迭代下用例"
                    />
                  </div>
                  <div className="rounded-lg border border-zinc-200 bg-white">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500">
                      <span>
                        可选用例（未关联 {pendingLinkRows.length} 条 / 本轮最多 200
                        条，按更新时间倒序）
                      </span>
                      <span>{caseLinkLoading ? "加载中…" : ""}</span>
                    </div>
                    <div className="max-h-[320px] overflow-auto">
                      {pendingLinkRows.length === 0 ? (
                        <div className="px-3 py-3 text-sm text-zinc-500">
                          {caseLinkLoading
                            ? "加载中…"
                            : "暂无可用用例（可能均已关联，或当前条件下无数据）。"}
                        </div>
                      ) : (
                        <table className="w-full min-w-[480px] table-fixed text-sm">
                          <colgroup>
                            <col style={{ width: 40 }} />
                            <col
                              style={{
                                width: Math.max(72, pendingPickLeftBlockW - 40),
                              }}
                            />
                            <col />
                          </colgroup>
                          <thead className="sticky top-0 z-[1] border-b border-zinc-100 bg-zinc-50 text-xs text-zinc-500">
                            <tr>
                              <th
                                colSpan={2}
                                className="relative px-2 py-2 text-left font-medium"
                              >
                                <div className="inline-flex items-center gap-2">
                                  <input
                                    ref={pendingLinkSelectAllRef}
                                    type="checkbox"
                                    className="h-3.5 w-3.5 shrink-0 rounded border-zinc-300"
                                    aria-label="全选可选用例"
                                    onChange={() => togglePendingLinkPickAll()}
                                  />
                                  <span>编号</span>
                                </div>
                                <TableColumnResizeHandle
                                  onResizeStart={startResizePendingNoVsTitle}
                                />
                              </th>
                              <th className="px-2 py-2 text-left font-medium">
                                名称 / 目录
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-100">
                            {pendingLinkRows.map((c) => (
                              <tr
                                key={c.id}
                                className="cursor-pointer hover:bg-zinc-50/70"
                                onClick={() => togglePendingLinkPick(c.id)}
                              >
                                <td
                                  className="px-2 py-2 align-middle"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    className="h-3.5 w-3.5 rounded border-zinc-300"
                                    checked={pendingLinkPickSet.has(c.id)}
                                    aria-label={`选择用例 ${c.caseNo}`}
                                    onChange={() => togglePendingLinkPick(c.id)}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                </td>
                                <td className="px-2 py-2 font-mono text-xs italic text-zinc-500 tabular-nums">
                                  {c.caseNo}
                                </td>
                                <td className="px-2 py-2 text-zinc-800">
                                  <div className="truncate">{c.title}</div>
                                  {c.folderName ? (
                                    <div className="mt-0.5 truncate text-[11px] text-zinc-500">
                                      {c.folderName}
                                    </div>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            ) : (
              <div className="rounded-lg border border-zinc-200 bg-white">
                <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600">
                  操作记录（最近 {initialOpLogs.length} 条）
                </div>
                <div className="max-h-[520px] overflow-auto">
                  {initialOpLogs.length === 0 ? (
                    <div className="px-3 py-3 text-sm text-zinc-500">暂无记录。</div>
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
                        {initialOpLogs.map((x) => (
                          <tr key={x.id} className="hover:bg-zinc-50/70">
                            <td className="px-3 py-2 align-top text-xs text-zinc-600 tabular-nums">
                              {formatOpTs(x.createdAt)}
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
          </div>
        </section>
      </div>
    </ModuleWorkspaceCard>
  );
}
