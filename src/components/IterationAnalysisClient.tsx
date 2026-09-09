"use client";

import {
  getIterationAnalysis,
  saveIterationAnalysis,
} from "@/app/actions/iteration-analysis";
import {
  ModuleWorkspaceCard,
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
} from "@/components/PageModuleLayout";
import {
  CATEGORIES_META,
  createEmptyIterationAnalysis,
  newCustomSection,
  readFileAsAttachment,
  type AnalysisSection,
  type CategoryKey,
  type IterationAnalysisData,
  type SectionAttachment,
} from "@/lib/iterationAnalysis";
import {
  buildIterationAnalysisHtmlReport,
  parseIterationAnalysisHtmlReport,
  triggerBlobDownload,
} from "@/lib/iterationAnalysisReport";
import { listIterationsByProduct } from "@/app/actions/iterations";
import type { ProductOption } from "@/app/actions/products";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

function buildListUrl(productId: string) {
  const p = new URLSearchParams();
  if (productId) p.set("productId", productId);
  const q = p.toString();
  return `/executions/iteration-analysis${q ? `?${q}` : ""}`;
}

function buildEditUrl(iterationId: string, productId: string) {
  const p = new URLSearchParams();
  p.set("edit", iterationId);
  if (productId) p.set("productId", productId);
  return `/executions/iteration-analysis?${p.toString()}`;
}

function ResizableTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={4}
      placeholder={placeholder}
      className="min-h-[96px] w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm outline-none transition-[border-color] focus:border-zinc-500"
    />
  );
}

function HtmlPreview({ html, title }: { html: string; title: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const fitIframeHeight = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;
    const h = Math.max(
      doc.documentElement?.scrollHeight ?? 0,
      doc.body?.scrollHeight ?? 0,
      80,
    );
    iframe.style.height = `${h}px`;
  }, []);

  useEffect(() => {
    fitIframeHeight();
    const t1 = window.setTimeout(fitIframeHeight, 100);
    const t2 = window.setTimeout(fitIframeHeight, 500);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [html, fitIframeHeight]);

  return (
    <div className="mt-2 overflow-visible rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 bg-zinc-50 px-3 py-1.5 text-xs text-zinc-500">
        HTML 预览：{title}
      </div>
      <iframe
        ref={iframeRef}
        title={`HTML 预览：${title}`}
        sandbox="allow-same-origin"
        srcDoc={html}
        scrolling="no"
        className="block w-full overflow-hidden border-0 bg-white"
        style={{ minHeight: 80 }}
        onLoad={fitIframeHeight}
      />
    </div>
  );
}

function ContentEditor({
  content,
  attachment,
  onContentChange,
  onAttachmentChange,
  placeholder,
}: {
  content: string;
  attachment: SectionAttachment | null | undefined;
  onContentChange: (v: string) => void;
  onAttachmentChange: (a: SectionAttachment | null) => void;
  placeholder?: string;
}) {
  const inputId = useId();
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadErr(null);
    const r = await readFileAsAttachment(file);
    if ("error" in r) {
      setUploadErr(r.error);
      return;
    }
    onAttachmentChange(r);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="file"
          className="hidden"
          accept=".html,.htm,text/html,*/*"
          onChange={onFile}
        />
        <label
          htmlFor={inputId}
          className={`${MODULE_TOOLBAR_BTN_SECONDARY} cursor-pointer`}
        >
          上传文件
        </label>
        {attachment ? (
          <button
            type="button"
            className="text-xs text-red-600 hover:underline"
            onClick={() => onAttachmentChange(null)}
          >
            清除附件
          </button>
        ) : null}
        {attachment ? (
          <span className="text-xs text-zinc-500">{attachment.fileName}</span>
        ) : null}
      </div>
      {uploadErr ? (
        <p className="text-xs text-red-600">{uploadErr}</p>
      ) : null}
      <ResizableTextarea
        value={content}
        onChange={onContentChange}
        placeholder={placeholder}
      />
      {attachment?.kind === "html" ? (
        <HtmlPreview html={attachment.payload} title={attachment.fileName} />
      ) : null}
      {attachment?.kind === "binary" ? (
        <a
          className="inline-block text-sm text-blue-600 hover:underline"
          href={`data:${attachment.mimeType};base64,${attachment.payload}`}
          download={attachment.fileName}
        >
          下载附件：{attachment.fileName}
        </a>
      ) : null}
    </div>
  );
}

export function IterationAnalysisClient({
  products,
  initialProductId,
  initialIterationId,
}: {
  products: ProductOption[];
  initialProductId?: string;
  initialIterationId: string;
}) {
  const router = useRouter();
  const importRef = useRef<HTMLInputElement>(null);
  const [productId, setProductId] = useState(initialProductId?.trim() ?? "");
  const [iterationId, setIterationId] = useState(initialIterationId.trim());
  const [iterationOptions, setIterationOptions] = useState<
    { id: string; label: string; productId: string }[]
  >([]);
  const [iterLoading, setIterLoading] = useState(false);
  const [data, setData] = useState<IterationAnalysisData>(
    createEmptyIterationAnalysis,
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saveHint, setSaveHint] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<CategoryKey | null>(null);
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newTitleInputRef = useRef<HTMLInputElement>(null);

  const iterationLabel =
    iterationOptions.find((it) => it.id === iterationId)?.label ?? "";

  useEffect(() => {
    if (!productId) {
      setIterationOptions([]);
      return;
    }
    let cancelled = false;
    setIterLoading(true);
    void listIterationsByProduct(productId).then((rows) => {
      if (cancelled) return;
      setIterationOptions(
        rows.map((r) => ({
          id: r.id,
          label: `${r.name}（${r.code}）`,
          productId: r.productId,
        })),
      );
      setIterLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  const load = useCallback(async (id: string) => {
    if (!id) {
      setData(createEmptyIterationAnalysis());
      return;
    }
    setLoading(true);
    setErr(null);
    setAddingFor(null);
    setPendingDelete(null);
    try {
      setData(await getIterationAnalysis(id));
    } catch {
      setErr("加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(iterationId);
  }, [iterationId, load]);

  useEffect(() => {
    if (addingFor && newTitleInputRef.current) {
      newTitleInputRef.current.focus();
    }
  }, [addingFor]);

  const persist = useCallback(
    async (next: IterationAnalysisData, silent?: boolean) => {
      if (!iterationId) return;
      setSaving(true);
      if (!silent) setSaveHint(null);
      const r = await saveIterationAnalysis(iterationId, next);
      setSaving(false);
      if (r.error) {
        setErr(r.error);
        return;
      }
      setErr(null);
      if (!silent) {
        setSaveHint("已保存");
        setTimeout(() => setSaveHint(null), 2000);
      }
    },
    [iterationId],
  );

  const scheduleSave = useCallback(
    (next: IterationAnalysisData) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        void persist(next, true);
      }, 800);
    },
    [persist],
  );

  const updateData = useCallback(
    (updater: (prev: IterationAnalysisData) => IterationAnalysisData) => {
      setData((prev) => {
        const next = updater(prev);
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  const updateSection = useCallback(
    (
      category: CategoryKey,
      sectionId: string,
      patch: Partial<Pick<AnalysisSection, "title" | "content" | "attachment">>,
    ) => {
      updateData((prev) => ({
        ...prev,
        [category]: {
          sections: prev[category].sections.map((s) =>
            s.id === sectionId ? { ...s, ...patch } : s,
          ),
        },
      }));
    },
    [updateData],
  );

  const startAddSection = useCallback((category: CategoryKey) => {
    setAddingFor(category);
    setNewSectionTitle("");
    setPendingDelete(null);
  }, []);

  const cancelAddSection = useCallback(() => {
    setAddingFor(null);
    setNewSectionTitle("");
  }, []);

  const confirmAddSection = useCallback(() => {
    if (!addingFor) return;
    const title = newSectionTitle.trim();
    if (!title) {
      setErr("请输入子栏目名称");
      return;
    }
    setErr(null);
    updateData((prev) => ({
      ...prev,
      [addingFor]: {
        sections: [...prev[addingFor].sections, newCustomSection(title)],
      },
    }));
    setAddingFor(null);
    setNewSectionTitle("");
  }, [addingFor, newSectionTitle, updateData]);

  const removeSection = useCallback(
    (category: CategoryKey, sectionId: string) => {
      updateData((prev) => ({
        ...prev,
        [category]: {
          sections: prev[category].sections.filter((s) => s.id !== sectionId),
        },
      }));
      setPendingDelete(null);
    },
    [updateData],
  );

  const onSaveNow = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    void persist(data);
  }, [data, persist]);

  const onExportReport = useCallback(() => {
    if (!iterationId) return;
    const html = buildIterationAnalysisHtmlReport(data, {
      iterationLabel: iterationLabel || iterationId,
      exportedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    });
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const date = new Date().toISOString().slice(0, 10);
    triggerBlobDownload(blob, `迭代分析报告_${date}.html`);
  }, [data, iterationId, iterationLabel]);

  const onImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !iterationId) return;
      try {
        const text = await file.text();
        const parsed = parseIterationAnalysisHtmlReport(text);
        if ("error" in parsed) {
          setErr(parsed.error);
          return;
        }
        if (
          !window.confirm(
            "确定用该 HTML 报告覆盖当前迭代的分析内容？此操作不可撤销（可先导出备份）。",
          )
        ) {
          return;
        }
        setData(parsed);
        setErr(null);
        await persist(parsed);
        setSaveHint("导入并已保存");
        setTimeout(() => setSaveHint(null), 2000);
      } catch {
        setErr("无法读取报告文件。");
      }
    },
    [iterationId, persist],
  );

  return (
    <ModuleWorkspaceCard>
      <div className="border-b border-zinc-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href={buildListUrl(productId)}
            className={MODULE_TOOLBAR_BTN_SECONDARY}
          >
            ← 返回列表
          </Link>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <span className="shrink-0">产品</span>
            <select
              className="min-w-[160px] rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm shadow-sm"
              value={productId}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) {
                  setProductId("");
                  return;
                }
                void listIterationsByProduct(v).then((rows) => {
                  const first = rows[0];
                  if (first) router.push(buildEditUrl(first.id, v));
                });
              }}
            >
              <option value="">请选择产品</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.code ? `（${p.code}）` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-700">
            <span className="shrink-0">迭代</span>
            <select
              className="min-w-[220px] rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-sm shadow-sm disabled:opacity-50"
              value={iterationId}
              disabled={!productId || iterLoading}
              onChange={(e) => {
                const v = e.target.value;
                if (v) router.push(buildEditUrl(v, productId));
              }}
            >
              <option value="">
                {productId ? "请选择迭代" : "请先选择产品"}
              </option>
              {iterationOptions.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.label}
                </option>
              ))}
            </select>
          </label>
          <input
            ref={importRef}
            type="file"
            className="hidden"
            accept=".html,.htm,text/html"
            onChange={onImportFile}
          />
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_SECONDARY}
            disabled={!iterationId || loading}
            onClick={() => importRef.current?.click()}
          >
            导入报告
          </button>
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_SECONDARY}
            disabled={!iterationId || loading}
            onClick={onExportReport}
          >
            导出报告
          </button>
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_SECONDARY}
            disabled={!iterationId || loading}
            onClick={() => void load(iterationId)}
          >
            重新加载
          </button>
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_PRIMARY}
            disabled={!iterationId || saving}
            onClick={onSaveNow}
          >
            {saving ? "保存中…" : "立即保存"}
          </button>
          {saveHint ? (
            <span className="text-sm text-emerald-600">{saveHint}</span>
          ) : null}
        </div>
        {err ? (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {err}
          </p>
        ) : null}
      </div>

      <div className="space-y-6 p-4">
        {loading ? (
          <p className="py-12 text-center text-sm text-zinc-500">加载中…</p>
        ) : !iterationId ? (
          <p className="py-12 text-center text-sm text-zinc-500">
            请先创建迭代后再填写迭代分析。
          </p>
        ) : (
          <>
            <section className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4">
              <h2 className="text-base font-semibold text-zinc-900">简言</h2>
              <p className="mt-0.5 mb-3 text-xs text-zinc-500">
                本迭代分析的总体简述；支持上传 HTML 等文件并预览
              </p>
              <ContentEditor
                content={data.brief}
                attachment={data.briefAttachment}
                onContentChange={(brief) =>
                  updateData((prev) => ({ ...prev, brief }))
                }
                onAttachmentChange={(briefAttachment) =>
                  updateData((prev) => ({ ...prev, briefAttachment }))
                }
                placeholder="请输入简言…"
              />
            </section>

            {CATEGORIES_META.map((cat) => (
              <section
                key={cat.key}
                className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4"
              >
                <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="text-base font-semibold text-zinc-900">
                      {cat.title}
                    </h2>
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {cat.description}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={MODULE_TOOLBAR_BTN_SECONDARY}
                    onClick={() => startAddSection(cat.key)}
                  >
                    + 添加子栏目
                  </button>
                </div>

                {addingFor === cat.key ? (
                  <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-zinc-300 bg-white p-3">
                    <input
                      ref={newTitleInputRef}
                      type="text"
                      value={newSectionTitle}
                      onChange={(e) => setNewSectionTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") confirmAddSection();
                        if (e.key === "Escape") cancelAddSection();
                      }}
                      placeholder="子栏目名称"
                      className="min-w-[200px] flex-1 rounded-lg border border-zinc-300 px-2.5 py-2 text-sm"
                    />
                    <button
                      type="button"
                      className={MODULE_TOOLBAR_BTN_PRIMARY}
                      onClick={confirmAddSection}
                    >
                      确定添加
                    </button>
                    <button
                      type="button"
                      className={MODULE_TOOLBAR_BTN_SECONDARY}
                      onClick={cancelAddSection}
                    >
                      取消
                    </button>
                  </div>
                ) : null}

                <ul className="space-y-4">
                  {data[cat.key].sections.map((section) => (
                    <li
                      key={section.id}
                      className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
                    >
                      <div className="mb-2 flex items-start justify-between gap-2">
                        {section.fixed ? (
                          <span className="text-sm font-medium text-zinc-800">
                            {section.title}
                          </span>
                        ) : (
                          <input
                            type="text"
                            value={section.title}
                            onChange={(e) =>
                              updateSection(cat.key, section.id, {
                                title: e.target.value,
                              })
                            }
                            className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-2.5 py-1.5 text-sm font-medium text-zinc-800"
                            placeholder="子栏目名称"
                          />
                        )}
                        {!section.fixed ? (
                          pendingDelete === section.id ? (
                            <span className="flex shrink-0 items-center gap-2 text-xs">
                              <button
                                type="button"
                                className="text-red-600 hover:underline"
                                onClick={() =>
                                  removeSection(cat.key, section.id)
                                }
                              >
                                确认删除
                              </button>
                              <button
                                type="button"
                                className="text-zinc-500 hover:underline"
                                onClick={() => setPendingDelete(null)}
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="shrink-0 text-xs text-red-600 hover:underline"
                              onClick={() => setPendingDelete(section.id)}
                            >
                              删除
                            </button>
                          )
                        ) : null}
                      </div>
                      <ContentEditor
                        content={section.content}
                        attachment={section.attachment}
                        onContentChange={(content) =>
                          updateSection(cat.key, section.id, { content })
                        }
                        onAttachmentChange={(attachment) =>
                          updateSection(cat.key, section.id, { attachment })
                        }
                        placeholder="在此输入内容（可拖动右下角上下拉伸）"
                      />
                    </li>
                  ))}
                  {data[cat.key].sections.length === 0 ? (
                    <li className="py-6 text-center text-sm text-zinc-400">
                      暂无子栏目，点击「添加子栏目」创建
                    </li>
                  ) : null}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </ModuleWorkspaceCard>
  );
}
