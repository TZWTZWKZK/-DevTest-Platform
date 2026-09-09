"use client";

import {
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
  ModuleWorkspaceCard,
} from "@/components/PageModuleLayout";
import {
  PERFORMANCE_REPORT_HEADERS,
  buildPerformanceReport,
  canUseDirectoryPicker,
  downloadPerformanceReportHtml,
  formatPerformanceReportCell,
  formatStatusBreakdownTooltip,
  isPerformanceRowWithStatus,
  loadPerformanceSummariesFromFsHits,
  parsePerformanceSummaryCsv,
  scanPerformanceRootViaDirectoryPicker,
  type PerformanceFsScanResult,
  type PerformanceFsSummaryHit,
  type PerformanceReportRow,
  type PerformanceSummaryRawRow,
} from "@/lib/performanceAnalysis";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function status200ToneClass(rate: number): string {
  if (rate < 90) {
    return "rounded-md border border-red-300 bg-red-50 px-1.5 py-0.5 font-medium text-red-800";
  }
  if (rate < 98) {
    return "rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900";
  }
  return "rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800";
}

function latencyAvgToneClass(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  if (ms > 1000) {
    return "rounded-md border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900";
  }
  return "rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-800";
}

function Status200Cell({ row }: { row: PerformanceReportRow }) {
  const text = formatPerformanceReportCell(row, "200占比");
  const tone = status200ToneClass(row.status200Rate);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const updatePos = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(
      rect.left,
      typeof window !== "undefined" ? window.innerWidth - 220 : rect.left,
    );
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, left),
    });
  }, []);

  const show = useCallback(() => {
    updatePos();
    setOpen(true);
  }, [updatePos]);

  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => updatePos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, updatePos]);

  return (
    <td className="px-3 py-2 align-top tabular-nums text-zinc-800">
      <span
        ref={anchorRef}
        className={`inline-flex cursor-help ${tone}`}
        tabIndex={0}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-describedby={open ? `status-tip-${row.method}-${row.uri}` : undefined}
      >
        {text}
      </span>
      {open && pos && typeof document !== "undefined"
        ? createPortal(
            <div
              id={`status-tip-${row.method}-${row.uri}`}
              role="tooltip"
              className="pointer-events-none fixed z-[300] min-w-[12rem] max-w-xs whitespace-pre-wrap rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-left text-xs leading-relaxed text-white shadow-xl"
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="mb-1 font-medium text-zinc-300">全部 status 占比</div>
              {formatStatusBreakdownTooltip(row)}
            </div>,
            document.body,
          )
        : null}
    </td>
  );
}

type PendingScan = {
  rootName: string;
  childFolderTotal: number;
  found: PerformanceFsSummaryHit[];
  missingFolders: string[];
};

export function PerformanceAnalysisClient() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [missingFolders, setMissingFolders] = useState<string[]>([]);
  const [parseErrors, setParseErrors] = useState<
    Array<{ folderName: string; relativePath: string; error: string }>
  >([]);
  const [loadedFolders, setLoadedFolders] = useState<string[]>([]);
  const [phase, setPhase] = useState<"idle" | "scanning" | "confirm" | "loading">(
    "idle",
  );
  const [scanCount, setScanCount] = useState(0);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [progressDone, setProgressDone] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [reportRows, setReportRows] = useState<PerformanceReportRow[]>([]);
  const [rawCount, setRawCount] = useState(0);
  const [validCount, setValidCount] = useState(0);

  const busy = phase === "scanning" || phase === "loading";

  const reset = useCallback(() => {
    setSourceLabel("");
    setError(null);
    setMissingFolders([]);
    setParseErrors([]);
    setLoadedFolders([]);
    setReportRows([]);
    setRawCount(0);
    setValidCount(0);
    setProgressDone(0);
    setProgressTotal(0);
    setScanCount(0);
    setPendingScan(null);
    setPhase("idle");
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const applyRows = useCallback(
    (
      rows: PerformanceSummaryRawRow[],
      meta: {
        sourceLabel: string;
        loadedFolders: string[];
        missingFolders: string[];
        parseErrors: Array<{
          folderName: string;
          relativePath: string;
          error: string;
        }>;
      },
    ) => {
      setSourceLabel(meta.sourceLabel);
      setLoadedFolders(meta.loadedFolders);
      setMissingFolders(meta.missingFolders);
      setParseErrors(meta.parseErrors);

      const usable = rows.filter(isPerformanceRowWithStatus);
      setRawCount(rows.length);
      setValidCount(usable.length);

      if (usable.length === 0) {
        setReportRows([]);
        setError(
          meta.loadedFolders.length === 0 && meta.parseErrors.length === 0
            ? "未找到任何 summary.csv，无法生成报告。"
            : "全部有效文件的 status 均为空，无法统计。",
        );
        return;
      }
      setError(null);
      setReportRows(buildPerformanceReport(usable));
    },
    [],
  );

  const onPickFile = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setPhase("loading");
      setPendingScan(null);
      setMissingFolders([]);
      setParseErrors([]);
      setLoadedFolders([]);
      setProgressDone(0);
      setProgressTotal(1);
      try {
        const text = await file.text();
        setProgressDone(1);
        const parsed = parsePerformanceSummaryCsv(text);
        if ("error" in parsed) {
          setReportRows([]);
          setRawCount(0);
          setValidCount(0);
          setSourceLabel(file.name);
          setError(parsed.error);
          return;
        }
        applyRows(parsed, {
          sourceLabel: file.name,
          loadedFolders: [file.name],
          missingFolders: [],
          parseErrors: [],
        });
      } catch {
        setReportRows([]);
        setRawCount(0);
        setValidCount(0);
        setSourceLabel(file.name);
        setError("读取文件失败，请确认是 UTF-8 编码的 summary.csv。");
      } finally {
        setPhase("idle");
      }
    },
    [applyRows],
  );

  const onPickDirectory = useCallback(async () => {
    if (!canUseDirectoryPicker()) {
      setError(
        "当前浏览器不支持目录选择器（需 Chrome / Edge）。请使用「单文件 summary.csv」，或换浏览器后选择压测目录。",
      );
      return;
    }
    setError(null);
    setPendingScan(null);
    setPhase("scanning");
    setScanCount(0);
    setProgressDone(0);
    setProgressTotal(0);
    try {
      const result = await scanPerformanceRootViaDirectoryPicker((n) => {
        setScanCount(n);
      });
      if ("error" in result) {
        setPhase("idle");
        if (!result.aborted) setError(result.error);
        return;
      }
      const scan = result as PerformanceFsScanResult;
      setPendingScan({
        rootName: scan.rootName,
        childFolderTotal: scan.childFolderTotal,
        found: scan.found,
        missingFolders: scan.missingFolders,
      });
      setMissingFolders(scan.missingFolders);
      setPhase("confirm");
      if (scan.childFolderTotal === 0) {
        setError("所选目录下没有子文件夹。");
      }
    } catch {
      setPhase("idle");
      setError("扫描目录失败，请重试。");
    }
  }, []);

  const onConfirmLoad = useCallback(async () => {
    if (!pendingScan) return;
    setPhase("loading");
    setError(null);
    setProgressDone(0);
    setProgressTotal(pendingScan.found.length);
    try {
      const merged = await loadPerformanceSummariesFromFsHits(
        pendingScan.found,
        pendingScan.missingFolders,
        pendingScan.childFolderTotal,
        (done, total) => {
          setProgressDone(done);
          setProgressTotal(total);
        },
      );
      applyRows(merged.rows, {
        sourceLabel: `目录「${pendingScan.rootName}」· 子节点 ${pendingScan.childFolderTotal} · 已加载 ${merged.loadedFolders.length} 个 summary.csv`,
        loadedFolders: merged.loadedFolders,
        missingFolders: merged.missingFolders,
        parseErrors: merged.parseErrors,
      });
      if (
        merged.loadedFolders.length === 0 &&
        pendingScan.childFolderTotal > 0
      ) {
        setError("确认加载后仍无可用的 summary.csv 数据。");
      }
      setPendingScan(null);
      setPhase("idle");
    } catch {
      setError("读取 summary.csv 失败，请重试。");
      setPhase("confirm");
    }
  }, [applyRows, pendingScan]);

  const onCancelConfirm = useCallback(() => {
    setPendingScan(null);
    setMissingFolders([]);
    setPhase("idle");
  }, []);

  return (
    <ModuleWorkspaceCard>
      <div className="border-b border-zinc-100 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_PRIMARY}
            disabled={busy}
            onClick={() => void onPickDirectory()}
          >
            {phase === "scanning" ? "扫描中…" : "选择压测目录"}
          </button>
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_SECONDARY}
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            单文件 summary.csv
          </button>
          {phase === "scanning" && scanCount > 0 ? (
            <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-medium tabular-nums text-blue-900">
              已扫描子节点：{scanCount}
            </span>
          ) : null}
          {phase === "loading" && progressTotal > 0 ? (
            <span className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-medium tabular-nums text-blue-900">
              已完成：{progressDone}/{progressTotal}
            </span>
          ) : null}
          {sourceLabel || reportRows.length > 0 || pendingScan ? (
            <button
              type="button"
              className={MODULE_TOOLBAR_BTN_SECONDARY}
              disabled={busy}
              onClick={reset}
            >
              清空
            </button>
          ) : null}
          {reportRows.length > 0 ? (
            <button
              type="button"
              className={MODULE_TOOLBAR_BTN_SECONDARY}
              disabled={busy}
              onClick={() =>
                downloadPerformanceReportHtml(reportRows, {
                  sourceFileName: sourceLabel || null,
                  rawCount: validCount,
                })
              }
            >
              导出 HTML
            </button>
          ) : null}
        </div>

        <p className="mt-2 text-xs text-zinc-500">
          {sourceLabel ? (
            <>
              已选：{sourceLabel}
              {rawCount > 0
                ? `（原始 ${rawCount.toLocaleString()} 条，有效 ${validCount.toLocaleString()} 条；已排除 status 为空）`
                : ""}
            </>
          ) : (
            <>
              选择压测根目录后，仅扫描各子节点第一层是否存在 summary.csv（不上传其它文件）；确认后再只读取这些
              summary.csv。建议使用 Chrome / Edge。
            </>
          )}
        </p>

        {pendingScan && phase === "confirm" ? (
          <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/80 px-3 py-3 text-sm text-blue-950">
            <div className="font-medium">扫描完成，请确认后再加载</div>
            <p className="mt-1 text-xs leading-relaxed text-blue-900/90">
              目录「{pendingScan.rootName}」共 {pendingScan.childFolderTotal}{" "}
              个子节点：找到{" "}
              <strong className="tabular-nums">{pendingScan.found.length}</strong>{" "}
              个 summary.csv；缺失{" "}
              <strong className="tabular-nums">
                {pendingScan.missingFolders.length}
              </strong>{" "}
              个。确认后将<strong>仅读取</strong>上述 summary.csv，不会上传
              exchanges 等其它文件。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={MODULE_TOOLBAR_BTN_PRIMARY}
                disabled={pendingScan.found.length === 0}
                onClick={() => void onConfirmLoad()}
              >
                确认加载（{pendingScan.found.length} 个文件）
              </button>
              <button
                type="button"
                className={MODULE_TOOLBAR_BTN_SECONDARY}
                onClick={onCancelConfirm}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </p>
        ) : null}

        {missingFolders.length > 0 ? (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            <div className="font-medium">
              以下 {missingFolders.length} 个文件夹未找到第一层 summary.csv：
            </div>
            <ul className="mt-1.5 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
              {missingFolders.map((name) => (
                <li key={name} className="break-all">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {parseErrors.length > 0 ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            <div className="font-medium">
              以下 {parseErrors.length} 个 summary.csv 解析失败：
            </div>
            <ul className="mt-1.5 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
              {parseErrors.map((e) => (
                <li key={`${e.folderName}:${e.relativePath}`} className="break-all">
                  <span className="font-medium">{e.folderName}</span>
                  {e.folderName !== e.relativePath ? (
                    <span className="text-red-700/80">（{e.relativePath}）</span>
                  ) : null}
                  ：{e.error}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {loadedFolders.length > 1 ? (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50/80 px-3 py-2 text-xs text-emerald-900">
            已合并 {loadedFolders.length} 个文件夹的数据：
            <span className="ml-1 break-all text-emerald-800/90">
              {loadedFolders.join("、")}
            </span>
          </div>
        ) : null}
      </div>

      {reportRows.length === 0 ? (
        <div className="px-6 py-16 text-center text-sm text-zinc-500">
          请选择压测目录并确认加载（或上传单个 summary.csv）生成统一性能报告。
        </div>
      ) : (
        <div className="flex min-h-0 flex-col">
          <div className="max-h-[min(72vh,calc(100dvh-15rem))] overflow-auto overscroll-contain">
            <table className="w-full min-w-[1100px] table-fixed border-collapse text-sm">
              <thead className="text-left text-xs font-medium text-zinc-600">
                <tr>
                  {PERFORMANCE_REPORT_HEADERS.map((h) => (
                    <th
                      key={h}
                      className={[
                        "sticky top-0 z-20 border-b border-zinc-200 bg-zinc-50 px-3 py-2.5 shadow-[0_1px_0_0_#e4e4e7]",
                        h === "URI" ? "w-[28%]" : "",
                        h === "时间范围" ? "w-[22%]" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {reportRows.map((row) => (
                  <tr
                    key={`${row.method}:${row.uri}`}
                    className="hover:bg-zinc-50/70"
                  >
                    {PERFORMANCE_REPORT_HEADERS.map((h) => {
                      if (h === "200占比") {
                        return <Status200Cell key={h} row={row} />;
                      }
                      const text = formatPerformanceReportCell(row, h);
                      const latencyTone =
                        h === "平均耗时(ms)"
                          ? latencyAvgToneClass(row.latencyAvgMs)
                          : "";
                      return (
                        <td
                          key={h}
                          className={[
                            "px-3 py-2 align-top text-zinc-800",
                            h === "URI" || h === "时间范围"
                              ? "break-all text-xs"
                              : "tabular-nums",
                            h === "Method" ? "font-medium" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          title={text}
                        >
                          {latencyTone ? (
                            <span className={`inline-flex ${latencyTone}`}>
                              {text}
                            </span>
                          ) : (
                            text
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="shrink-0 border-t border-zinc-100 bg-white px-4 py-2.5 text-xs text-zinc-500">
            共 {reportRows.length} 个接口（URI × Method）；仅合并已确认的
            summary.csv；已剔除 status 为空。
          </div>
        </div>
      )}
    </ModuleWorkspaceCard>
  );
}
