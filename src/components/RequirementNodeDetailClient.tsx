"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  addRequirementAttachment,
  deleteRequirementAttachment,
  getRequirementOpLogs,
  updateRequirementNodeDetail,
  type ActionResult,
  type RequirementOpLogRow,
} from "@/app/actions/requirements";
import { RequirementPrioritySelect } from "@/components/RequirementPrioritySelect";
import { ModuleWorkspaceCard } from "@/components/PageModuleLayout";
import { deriveRequirementStatusFromTaskProgress } from "@/lib/requirement-progress-status";
import {
  beijingDatetimeLocalToIsoOrNull,
  formatIsoBeijing,
  isoToBeijingDatetimeLocal,
} from "@/lib/timezone-cn";

function formatOpTs(iso: string): string {
  return formatIsoBeijing(iso, { withSeconds: true });
}

function isoToDatetimeLocal(iso: string | null | undefined): string {
  return isoToBeijingDatetimeLocal(iso);
}

function datetimeLocalToIsoOrNull(v: string): string | null {
  return beijingDatetimeLocalToIsoOrNull(v);
}

const requirementStatusLabel = {
  UNASSIGNED: "未分配",
  IN_DEVELOPMENT: "开发中",
  PENDING_VERIFICATION: "待验证",
  CLOSED: "已上线",
} as const;

const requirementStatusBadgeClass = {
  UNASSIGNED: "border-violet-500/80 bg-violet-50 text-violet-800",
  IN_DEVELOPMENT: "border-red-500/80 bg-red-50 text-red-800",
  PENDING_VERIFICATION: "border-emerald-500/80 bg-emerald-50 text-emerald-800",
  CLOSED: "border-blue-500/80 bg-blue-50 text-blue-800",
} as const;

export function RequirementNodeDetailClient({
  nodeId,
  iterationId,
  breadcrumb,
  initialTitle,
  initialDescription,
  initialTaskProgress,
  initialLatestProgress,
  initialPriority,
  initialStatus,
  initialSubmitter,
  initialDevOwner,
  initialTestOwner,
  initialPlanStartAt,
  initialPlanEndAt,
  initialUpdatedAt,
  initialWbsId,
  initialAttachments,
  initialOpLogs,
}: {
  nodeId: string;
  iterationId: string;
  breadcrumb: string;
  initialTitle: string;
  initialWbsId: string | null;
  initialDescription: string | null;
  initialTaskProgress: string | null;
  initialLatestProgress: string | null;
  initialPriority: number | null;
  initialStatus: keyof typeof requirementStatusLabel;
  initialSubmitter: string | null;
  initialDevOwner: string | null;
  initialTestOwner: string | null;
  initialPlanStartAt: string | null;
  initialPlanEndAt: string | null;
  initialUpdatedAt: string;
  initialAttachments: { id: string; name: string; url: string; createdAt: string }[];
  initialOpLogs: RequirementOpLogRow[];
}) {
  const [title, setTitle] = useState(initialTitle);
  const [wbsId, setWbsId] = useState(initialWbsId ?? "");
  const [description, setDescription] = useState(initialDescription ?? "");
  const [taskProgress, setTaskProgress] = useState(initialTaskProgress ?? "");
  const [latestProgress, setLatestProgress] = useState(
    initialLatestProgress ?? "",
  );
  const [priority, setPriority] = useState(
    initialPriority === null || initialPriority === undefined
      ? ""
      : String(initialPriority),
  );
  const [status, setStatus] = useState(initialStatus);
  const [submitter] = useState(initialSubmitter ?? "");
  const [devOwner, setDevOwner] = useState(initialDevOwner ?? "");
  const [testOwner, setTestOwner] = useState(initialTestOwner ?? "");
  const [planStartLocal, setPlanStartLocal] = useState(() =>
    isoToDatetimeLocal(initialPlanStartAt),
  );
  const [planEndLocal, setPlanEndLocal] = useState(() =>
    isoToDatetimeLocal(initialPlanEndAt),
  );
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt);
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const [saving, setSaving] = useState(false);

  const [attachments, setAttachments] = useState(initialAttachments);
  const [attBusy, setAttBusy] = useState(false);
  const [attDeletePending, setAttDeletePending] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const attFileRef = useRef<HTMLInputElement | null>(null);

  const [detailTab, setDetailTab] = useState<"detail" | "ops">("detail");
  const [opLogs, setOpLogs] = useState<RequirementOpLogRow[]>(initialOpLogs);

  useEffect(() => {
    setOpLogs(initialOpLogs);
  }, [initialOpLogs]);

  useEffect(() => {
    setPlanStartLocal(isoToDatetimeLocal(initialPlanStartAt));
    setPlanEndLocal(isoToDatetimeLocal(initialPlanEndAt));
  }, [initialPlanStartAt, initialPlanEndAt]);

  const MAX_ATT_FILE_BYTES = 10 * 1024 * 1024;

  const refreshOpLogs = async () => {
    const next = await getRequirementOpLogs(nodeId, 50);
    setOpLogs(next);
  };

  const save = async () => {
    setSaving(true);
    setMsg(null);
    const pri =
      priority.trim() === "" ? null : Number.parseInt(priority.trim(), 10);
    const r = await updateRequirementNodeDetail({
      id: nodeId,
      title,
      wbsId: wbsId.trim() || null,
      description: description.trim() || null,
      taskProgress: taskProgress.trim() || null,
      latestProgress: latestProgress.trim() || null,
      priority: pri !== null && Number.isNaN(pri) ? null : pri,
      status,
      submitter: submitter.trim() || null,
      devOwner: devOwner.trim() || null,
      testOwner: testOwner.trim() || null,
      planStartAt: datetimeLocalToIsoOrNull(planStartLocal),
      planEndAt: datetimeLocalToIsoOrNull(planEndLocal),
    });
    setSaving(false);
    setMsg(r);
    if (r.ok) {
      const derived = deriveRequirementStatusFromTaskProgress(
        taskProgress.trim() || null,
      );
      if (derived !== null) setStatus(derived);
      setUpdatedAt(new Date().toISOString());
      void refreshOpLogs();
    }
  };

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result ?? ""));
      fr.onerror = () => reject(new Error("读取文件失败"));
      fr.readAsDataURL(file);
    });

  const onAttachmentFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_ATT_FILE_BYTES) {
      setMsg({
        error: `「${file.name}」超过 10MB 上限，请选择较小的文件。`,
      });
      return;
    }
    setAttBusy(true);
    setMsg(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const r = await addRequirementAttachment({
        requirementId: nodeId,
        name: file.name,
        url: dataUrl,
      });
      if ("error" in r) {
        setMsg({ error: r.error });
        return;
      }
      setAttachments((prev) => [
        {
          id: r.id,
          name: file.name,
          url: dataUrl,
          createdAt: r.createdAt,
        },
        ...prev,
      ]);
      void refreshOpLogs();
    } catch {
      setMsg({ error: "读取或上传附件失败，请重试。" });
    } finally {
      setAttBusy(false);
    }
  };

  const requestRemoveAtt = (id: string, name: string) => {
    setMsg(null);
    setAttDeletePending({ id, name });
  };

  const executeRemoveAtt = async () => {
    if (!attDeletePending) return;
    const { id } = attDeletePending;
    setAttBusy(true);
    setMsg(null);
    const r = await deleteRequirementAttachment(id);
    setAttBusy(false);
    if (r.error) {
      setMsg(r);
      return;
    }
    setAttDeletePending(null);
    setAttachments((prev) => prev.filter((x) => x.id !== id));
    void refreshOpLogs();
  };

  return (
    <ModuleWorkspaceCard>
      <div className="flex min-h-[70vh] flex-col lg:flex-row">
        <section className="flex min-h-[200px] flex-col border-b border-zinc-200 bg-zinc-50/60 lg:w-[min(30%,320px)] lg:min-h-0 lg:border-b-0 lg:border-r lg:border-zinc-200">
          <div className="shrink-0 border-b border-zinc-200/80 p-3">
            <h2 className="text-sm font-semibold text-zinc-900">导航</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              返回需求树列表，或通过面包屑确认所属产品与迭代。
            </p>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <Link
              href={`/requirements?iterationId=${encodeURIComponent(iterationId)}&focusNode=${encodeURIComponent(nodeId)}`}
              className="inline-flex text-sm font-medium text-blue-700 hover:underline"
            >
              ← 返回需求树
            </Link>
            <div className="rounded-lg border border-zinc-200/80 bg-white p-2.5 text-xs leading-relaxed text-zinc-600">
              {breadcrumb}
            </div>
          </div>
        </section>

        <section className="min-w-0 flex-1 bg-white">
          <div className="border-b border-zinc-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-zinc-900">需求详情</h2>
            <div className="mt-2 max-w-[820px]">
              <input
                className="w-full rounded-lg border border-transparent bg-transparent px-0 py-0 text-lg font-semibold text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-transparent focus:ring-0"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setMsg(null);
                }}
                placeholder="任务名称"
              />
              <label className="mt-3 block text-xs font-medium text-zinc-600">
                WBS 编号
              </label>
              <input
                className="mt-0.5 w-full max-w-md rounded-lg border border-zinc-200 px-2 py-1.5 text-sm font-mono tabular-nums text-zinc-800 outline-none focus:ring-2 focus:ring-zinc-300"
                value={wbsId}
                onChange={(e) => {
                  setWbsId(e.target.value);
                  setMsg(null);
                }}
                placeholder="如 1、1.1、2.1.2（同一迭代内需唯一，可留空）"
                aria-label="WBS 编号"
              />
              <div className="mt-1 text-xs text-zinc-500">
                修改时间：{formatOpTs(updatedAt)}
              </div>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              编辑任务名称、优先级与描述；保存后将在测试设计中作为挂载对象使用。
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 pb-3">
              <div className="inline-flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs">
                <button
                  type="button"
                  aria-selected={detailTab === "detail"}
                  className={[
                    "rounded-md px-2.5 py-1 font-medium",
                    detailTab === "detail"
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-700 hover:bg-zinc-50",
                  ].join(" ")}
                  onClick={() => setDetailTab("detail")}
                >
                  需求详情
                </button>
                <button
                  type="button"
                  aria-selected={detailTab === "ops"}
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
                {detailTab === "detail"
                  ? "编辑描述、附件与优先级等信息后保存。"
                  : `最近 ${opLogs.length} 条`}
              </div>
            </div>
          </div>
          <div className="space-y-3 px-4 py-4">
            {msg?.error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {msg.error}
              </div>
            )}
            {msg?.ok && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                已保存
              </div>
            )}

            {detailTab === "detail" ? (
            <div className="grid gap-5 lg:grid-cols-[2fr_1fr]">
              <div className="min-w-0 space-y-3">
                <div>
                  <label className="text-xs font-medium text-zinc-600">
                    描述
                  </label>
                  <textarea
                    className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                    rows={8}
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setMsg(null);
                    }}
                  />
                </div>

                <section className="rounded-xl border border-zinc-200 bg-zinc-50/40 p-4">
                  <h3 className="text-sm font-semibold text-zinc-800">
                    相关附件
                  </h3>
                  <p className="mt-1 text-xs text-zinc-500">
                    从本机选择文件上传（单文件不超过 10MB）；数据保存在当前环境数据库中，适合内网/演示。
                  </p>
                  <input
                    ref={attFileRef}
                    type="file"
                    className="sr-only"
                    aria-hidden
                    tabIndex={-1}
                    disabled={attBusy}
                    onChange={onAttachmentFileChange}
                  />
                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      disabled={attBusy}
                      onClick={() => attFileRef.current?.click()}
                      className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      {attBusy ? "处理中…" : "添加附件"}
                    </button>
                  </div>
                  <div className="mt-3 rounded-lg border border-zinc-100 bg-white">
                    {attachments.length === 0 ? (
                      <p className="p-3 text-sm text-zinc-500">暂无附件</p>
                    ) : (
                      <ul className="divide-y divide-zinc-100">
                        {attachments.map((a) => (
                          <li
                            key={a.id}
                            className={`flex items-start justify-between gap-3 px-3 py-2 ${
                              attDeletePending?.id === a.id
                                ? "bg-amber-50/60"
                                : ""
                            }`}
                          >
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-zinc-900">
                                {a.name}
                              </div>
                              {a.url.startsWith("data:") ? (
                                <a
                                  href={a.url}
                                  download={a.name}
                                  className="mt-0.5 inline-block truncate text-xs text-blue-700 hover:underline"
                                >
                                  下载文件
                                </a>
                              ) : (
                                <a
                                  href={a.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="block truncate text-xs text-blue-700 hover:underline"
                                  title={a.url}
                                >
                                  {a.url}
                                </a>
                              )}
                            </div>
                            <button
                              type="button"
                              disabled={attBusy}
                              aria-label={`删除附件「${a.name}」，需在下方确认`}
                              className="shrink-0 rounded border border-red-200 bg-white px-2 py-0.5 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                              onClick={() => requestRemoveAtt(a.id, a.name)}
                            >
                              删除
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {attDeletePending ? (
                      <div
                        className="border-t border-amber-200 bg-amber-50 px-3 py-2.5"
                        role="region"
                        aria-label="删除附件确认"
                      >
                        <p className="text-sm font-medium text-amber-950">
                          确认删除该附件？
                        </p>
                        <p className="mt-1 text-xs text-amber-900/90">
                          「{attDeletePending.name}」删除后无法恢复。
                        </p>
                        <div className="mt-2 flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            disabled={attBusy}
                            className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
                            onClick={() => setAttDeletePending(null)}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            disabled={attBusy}
                            className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                            onClick={() => void executeRemoveAtt()}
                          >
                            {attBusy ? "删除中…" : "确认删除"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>

              <section className="rounded-xl border border-transparent bg-transparent p-0">
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      优先级（高 / 中 / 低）
                    </label>
                    <RequirementPrioritySelect
                      value={priority}
                      onChange={(v) => {
                        setPriority(v);
                        setMsg(null);
                      }}
                      className="mt-1 w-full px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      需求状态
                    </label>
                    <select
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      value={status}
                      onChange={(e) => {
                        setStatus(e.target.value as typeof status);
                        setMsg(null);
                      }}
                    >
                      {Object.entries(requirementStatusLabel).map(
                        ([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ),
                      )}
                    </select>
                    <div className="mt-1.5">
                      <span
                        className={[
                          "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                          requirementStatusBadgeClass[status],
                        ].join(" ")}
                      >
                        {requirementStatusLabel[status]}
                      </span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      任务进度
                    </label>
                    <textarea
                      className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                      rows={3}
                      placeholder="如：60%、联调阶段、待评审"
                      value={taskProgress}
                      onChange={(e) => {
                        setTaskProgress(e.target.value);
                        setMsg(null);
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      最新进展情况
                    </label>
                    <textarea
                      className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                      rows={4}
                      placeholder="可填写当前进展、阻塞点、预计完成时间等"
                      value={latestProgress}
                      onChange={(e) => {
                        setLatestProgress(e.target.value);
                        setMsg(null);
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      提交人
                    </label>
                    <input
                      className="mt-1 w-full cursor-not-allowed rounded-lg border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-600"
                      value={submitter}
                      disabled
                      title="提交人默认不可修改"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      开发负责人
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      value={devOwner}
                      onChange={(e) => {
                        setDevOwner(e.target.value);
                        setMsg(null);
                      }}
                      placeholder="例如：李四"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      测试负责人
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm"
                      value={testOwner}
                      onChange={(e) => {
                        setTestOwner(e.target.value);
                        setMsg(null);
                      }}
                      placeholder="例如：王五"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      计划开始时间
                    </label>
                    <input
                      type="datetime-local"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm tabular-nums"
                      value={planStartLocal}
                      onChange={(e) => {
                        setPlanStartLocal(e.target.value);
                        setMsg(null);
                      }}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-zinc-600">
                      计划结束时间
                    </label>
                    <input
                      type="datetime-local"
                      className="mt-1 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm tabular-nums"
                      value={planEndLocal}
                      onChange={(e) => {
                        setPlanEndLocal(e.target.value);
                        setMsg(null);
                      }}
                    />
                  </div>
                </div>
              </section>
            </div>
            ) : (
              <div className="rounded-lg border border-zinc-200 bg-white">
                <div className="border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600">
                  操作记录（最近 {opLogs.length} 条）
                </div>
                <div className="max-h-[520px] overflow-auto">
                  {opLogs.length === 0 ? (
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
                        {opLogs.map((x) => (
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

            {detailTab === "detail" ? (
            <div className="flex justify-end">
              <button
                type="button"
                disabled={saving}
                onClick={save}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
            ) : null}
          </div>
        </section>
      </div>
    </ModuleWorkspaceCard>
  );
}

