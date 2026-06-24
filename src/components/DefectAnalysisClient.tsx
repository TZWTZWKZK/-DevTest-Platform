"use client";

import {
  MODULE_TOOLBAR_BTN_PRIMARY,
  MODULE_TOOLBAR_BTN_SECONDARY,
  ModuleWorkspaceCard,
} from "@/components/PageModuleLayout";
import { useCallback, useMemo, useRef, useState } from "react";
import { DEFECT_ANALYSIS_REPORT_SCRIPT } from "@/lib/defectAnalysisReportScript";
import * as XLSX from "xlsx";

export type DefectAnalysisRow = {
  bugBrief: string;
  similarCount: number;
  defectType: string;
  defectSummary: string;
};

type TypeGroup = {
  defectType: string;
  defectSummary: string;
  totalCount: number;
  bugs: { brief: string; count: number }[];
};

const REQUIRED_HEADERS = [
  "bug简述",
  "同类缺陷个数",
  "缺陷类型",
  "缺陷总结",
] as const;

const PIE_COLORS = [
  "#18181b",
  "#3f3f46",
  "#52525b",
  "#71717a",
  "#a1a1aa",
  "#0d9488",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#c026d3",
];

function normalizeHeaderKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, "")
    .toLowerCase();
}

function buildHeaderIndex(headerRow: unknown[]): Map<string, number> {
  const headerIndex = new Map<string, number>();
  headerRow.forEach((h, idx) => {
    const key = String(h ?? "").trim();
    if (key) headerIndex.set(key, idx);
    const norm = normalizeHeaderKey(h);
    if (norm) headerIndex.set(norm, idx);
  });
  return headerIndex;
}

const HEADER_ALIASES: Record<(typeof REQUIRED_HEADERS)[number], string[]> = {
  bug简述: ["bug简述", "Bug简述", "BUG简述", "bug描述", "缺陷简述"],
  同类缺陷个数: ["同类缺陷个数", "同类缺陷数", "缺陷个数"],
  缺陷类型: ["缺陷类型", "类型"],
  缺陷总结: ["缺陷总结", "总结"],
};

function resolveHeaderIndex(
  headerIndex: Map<string, number>,
  canonical: (typeof REQUIRED_HEADERS)[number],
): number | undefined {
  for (const name of HEADER_ALIASES[canonical]) {
    const i = headerIndex.get(name);
    if (i !== undefined) return i;
  }
  const i = headerIndex.get(normalizeHeaderKey(canonical));
  return i;
}

function cellAtCol(
  cells: string[],
  col: number | undefined,
): string {
  if (col === undefined || col < 0 || col >= cells.length) return "";
  const raw = cells[col];
  if (raw === undefined || raw === null) return "";
  return String(raw).trim();
}

function parseSimilarCount(raw: string): number {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

export function parseDefectAnalysisExcel(
  buf: ArrayBuffer,
): DefectAnalysisRow[] | { error: string } {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: "array" });
  } catch {
    return { error: "无法解析 Excel 文件，请使用 .xlsx 或 .xls。" };
  }
  if (!wb.SheetNames?.length) {
    return { error: "Excel 文件中没有工作表" };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: "",
    blankrows: false,
  });
  if (!matrix.length) {
    return { error: "工作表为空" };
  }
  const headerRow = matrix[0] as unknown[];
  const headerIndex = buildHeaderIndex(headerRow);
  const colBug = resolveHeaderIndex(headerIndex, "bug简述");
  const colCount = resolveHeaderIndex(headerIndex, "同类缺陷个数");
  const colType = resolveHeaderIndex(headerIndex, "缺陷类型");
  const colSummary = resolveHeaderIndex(headerIndex, "缺陷总结");
  for (const h of REQUIRED_HEADERS) {
    if (resolveHeaderIndex(headerIndex, h) === undefined) {
      const labels = [...new Set(headerRow.map((x) => String(x ?? "").trim()))]
        .filter(Boolean)
        .join("、");
      return {
        error: `表头须包含「${h}」列；当前表头：${labels || "（空）"}`,
      };
    }
  }

  const rows: DefectAnalysisRow[] = [];
  let carryType = "";
  let carrySummary = "";
  let carryCount = 0;

  for (const rawRow of matrix.slice(1) as unknown[][]) {
    const cells = rawRow.map((c) => {
      if (c === undefined || c === null) return "";
      return String(c).trim();
    });
    if (cells.every((c) => !c)) continue;

    const typeRaw = cellAtCol(cells, colType);
    const summaryRaw = cellAtCol(cells, colSummary);
    const bugBrief = cellAtCol(cells, colBug);
    const countRaw = cellAtCol(cells, colCount);
    const parsedCount = parseSimilarCount(countRaw);

    if (typeRaw) carryType = typeRaw;
    if (summaryRaw) carrySummary = summaryRaw;
    if (parsedCount > 0) carryCount = parsedCount;

    const defectType = typeRaw || carryType;
    const defectSummary = summaryRaw || carrySummary;
    const similarCount = parsedCount > 0 ? parsedCount : carryCount;

    if (!defectType && !bugBrief && !defectSummary) continue;

    rows.push({
      bugBrief,
      similarCount,
      defectType: defectType || "（未分类）",
      defectSummary,
    });
  }
  if (rows.length === 0) {
    return { error: "未解析到有效数据行，请检查 Excel 内容。" };
  }
  return rows;
}

/** 将单元格内的多条 bug 简述拆成列表（换行或「1.」「2、」等编号，保留原编号） */
function splitBugBriefs(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const byLine = t
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byLine.length > 1) return byLine;
  const numbered = t
    .split(/(?=\d+[.、．)）])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (numbered.length > 1) return numbered;
  return [t];
}

/** 合并同类型多行缺陷总结，优先保留更完整内容 */
function mergeDefectSummary(prev: string, next: string): string {
  const n = next.trim();
  if (!n) return prev.trim();
  const p = prev.trim();
  if (!p) return n;
  if (p === n || p.includes(n)) return p;
  if (n.includes(p)) return n;
  return `${p}\n${n}`;
}

function groupByDefectType(rows: DefectAnalysisRow[]): TypeGroup[] {
  const map = new Map<string, TypeGroup>();
  const countAdded = new Map<string, boolean>();

  for (const r of rows) {
    let g = map.get(r.defectType);
    if (!g) {
      g = {
        defectType: r.defectType,
        defectSummary: "",
        totalCount: 0,
        bugs: [],
      };
      map.set(r.defectType, g);
      countAdded.set(r.defectType, false);
    }

    g.defectSummary = mergeDefectSummary(g.defectSummary, r.defectSummary);

    const countKey = r.defectType;
    if (!countAdded.get(countKey) && r.similarCount > 0) {
      g.totalCount = r.similarCount;
      countAdded.set(countKey, true);
    } else if (!countAdded.get(countKey)) {
      g.totalCount += r.similarCount;
    }

    const briefs = splitBugBriefs(r.bugBrief);
    for (const brief of briefs) {
      if (brief.trim()) {
        g.bugs.push({ brief: brief.trim(), count: r.similarCount });
      }
    }
  }

  return [...map.values()].sort((a, b) => b.totalCount - a.totalCount);
}

type PieSlice = {
  defectType: string;
  value: number;
  percent: number;
  color: string;
  path: string;
  startAngle: number;
  endAngle: number;
  midAngle: number;
};

function pieSlicePath(
  cx: number,
  cy: number,
  r: number,
  startAngle: number,
  endAngle: number,
  explode = 0,
): string {
  const mid = (startAngle + endAngle) / 2;
  const ox = explode * Math.cos(mid);
  const oy = explode * Math.sin(mid);
  const x = cx + ox;
  const y = cy + oy;
  const sweep = endAngle - startAngle;
  const frac = sweep / (2 * Math.PI);
  if (frac >= 0.9999) {
    return `M ${x} ${y - r} A ${r} ${r} 0 1 1 ${x - 0.01} ${y - r} Z`;
  }
  const x1 = x + r * Math.cos(startAngle);
  const y1 = y + r * Math.sin(startAngle);
  const x2 = x + r * Math.cos(endAngle);
  const y2 = y + r * Math.sin(endAngle);
  const large = sweep > Math.PI ? 1 : 0;
  return `M ${x} ${y} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

function buildPieSlices(
  groups: TypeGroup[],
  size: number,
  hoveredType: string | null,
): PieSlice[] {
  const total = groups.reduce((s, g) => s + g.totalCount, 0);
  if (total <= 0) return [];
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;
  let angle = -Math.PI / 2;
  return groups.map((g, i) => {
    const frac = g.totalCount / total;
    const sweep = frac * 2 * Math.PI;
    const startAngle = angle;
    const endAngle = angle + sweep;
    const explode = hoveredType === g.defectType ? 10 : 0;
    const path = pieSlicePath(cx, cy, r, startAngle, endAngle, explode);
    const slice: PieSlice = {
      defectType: g.defectType,
      value: g.totalCount,
      percent: frac * 100,
      color: PIE_COLORS[i % PIE_COLORS.length],
      path,
      startAngle,
      endAngle,
      midAngle: (startAngle + endAngle) / 2,
    };
    angle = endAngle;
    return slice;
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function triggerDownload(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportAnalysisExcel(rows: DefectAnalysisRow[]) {
  const detailRows = rows.map((r) => ({
    bug简述: r.bugBrief,
    同类缺陷个数: r.similarCount,
    缺陷类型: r.defectType,
    缺陷总结: r.defectSummary,
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(detailRows),
    "数据",
  );
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array", bookSST: false });
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const date = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `缺陷分析数据_${date}.xlsx`);
}

function buildAnalysisHtmlReport(
  groups: TypeGroup[],
  sourceFileName: string | null,
): string {
  const total = groups.reduce((s, g) => s + g.totalCount, 0);
  const slices = buildPieSlices(groups, 320, null);
  const generatedAt = new Date().toLocaleString("zh-CN", { hour12: false });
  const summaryByType = new Map(
    groups.map((g) => [g.defectType, g.defectSummary]),
  );

  const pieJson = JSON.stringify(
    slices.map((s) => ({
      type: s.defectType,
      value: s.value,
      percent: s.percent,
      color: s.color,
      startAngle: s.startAngle,
      endAngle: s.endAngle,
      summary: summaryByType.get(s.defectType) ?? "",
    })),
  ).replace(/</g, "\\u003c");

  const piePaths = slices
    .map(
      (s, i) =>
        `<path class="pie-slice" data-idx="${i}" d="${s.path}" fill="${s.color}" stroke="#fff" stroke-width="1" />`,
    )
    .join("");

  const legend = slices
    .map(
      (s, i) => `
        <li class="legend-item" data-idx="${i}">
          <span class="legend-swatch" style="background:${s.color}"></span>
          <span>${escapeHtml(s.defectType)} — ${s.value}（${s.percent.toFixed(1)}%）</span>
        </li>`,
    )
    .join("");

  const statRows = groups
    .map((g) => {
      const pct =
        total > 0 ? ((g.totalCount / total) * 100).toFixed(1) : "0.0";
      return `<tr>
        <td>${escapeHtml(g.defectType)}</td>
        <td class="num">${g.totalCount}</td>
        <td class="num">${pct}%</td>
      </tr>`;
    })
    .join("");

  const typeSections = groups
    .map((g, idx) => {
      const bugs = g.bugs.filter((b) => b.brief.trim());
      const bugList =
        bugs.length > 0
          ? `<ul class="bug-list">${bugs
              .map(
                (b, bi) =>
                  `<li><span class="bug-idx">${bi + 1}.</span>${escapeHtml(b.brief)}</li>`,
              )
              .join("")}</ul>`
          : `<p class="muted">无 bug 简述</p>`;
      const summary = g.defectSummary.trim()
        ? `<p class="summary">${escapeHtml(g.defectSummary).replace(/\n/g, "<br>")}</p>`
        : `<p class="muted">（无缺陷总结）</p>`;
      return `
        <li class="type-item">
          <button type="button" class="type-toggle" aria-expanded="false" aria-controls="type-panel-${idx}">
            <span class="chevron" aria-hidden="true">▶</span>
            <span class="type-head">
              <span class="type-title">
                <strong>${escapeHtml(g.defectType)}</strong>
                <span class="badge">同类缺陷 ${g.totalCount} 个 · ${bugs.length} 条简述</span>
              </span>
              ${summary}
            </span>
          </button>
          <div id="type-panel-${idx}" class="type-panel" hidden>
            <h4 class="panel-label">bug 简述</h4>
            ${bugList}
          </div>
        </li>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>缺陷分析报告</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px 40px; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #18181b; background: #fafafa; line-height: 1.6; }
    h1 { margin: 0 0 8px; font-size: 1.75rem; }
    .meta { color: #71717a; font-size: 0.875rem; margin-bottom: 28px; }
    .card { background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; padding: 24px; margin-bottom: 24px; }
    h2 { margin: 0 0 16px; font-size: 1.125rem; }
    .chart-wrap { position: relative; flex-shrink: 0; }
    .chart-row { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; }
    .pie-slice { cursor: pointer; transition: opacity 0.2s, filter 0.2s; }
    .pie-slice.dim { opacity: 0.72; }
    .pie-slice.active { filter: drop-shadow(0 2px 6px rgba(0,0,0,0.18)); }
    .pie-tooltip { position: fixed; z-index: 100; max-width: 280px; padding: 10px 12px; background: #fff; border: 1px solid #e4e4e7; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.12); font-size: 12px; pointer-events: none; transform: translate(-50%, calc(-100% - 10px)); display: none; }
    .pie-tooltip.show { display: block; }
    .pie-tooltip strong { display: block; margin-bottom: 4px; }
    .pie-tooltip .tip-meta { color: #52525b; }
    .pie-tooltip .tip-summary { margin-top: 6px; color: #71717a; line-height: 1.5; max-height: 4.5em; overflow: hidden; }
    .legend { list-style: none; padding: 0; margin: 0; flex: 1; min-width: 200px; }
    .legend-item { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 8px; font-size: 0.875rem; padding: 2px 4px; border-radius: 6px; cursor: default; }
    .legend-item.active { background: #f4f4f5; }
    .legend-swatch { width: 10px; height: 10px; border-radius: 2px; margin-top: 5px; flex-shrink: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th, td { border: 1px solid #e4e4e7; padding: 8px 12px; text-align: left; }
    th { background: #f4f4f5; font-weight: 600; }
    td.num { text-align: right; }
    .type-list { list-style: none; margin: 0; padding: 0; border: 1px solid #e4e4e7; border-radius: 8px; overflow: hidden; }
    .type-item { border-bottom: 1px solid #f4f4f5; }
    .type-item:last-child { border-bottom: none; }
    .type-toggle { display: flex; width: 100%; gap: 8px; padding: 12px 16px; border: none; background: transparent; text-align: left; cursor: pointer; font: inherit; color: inherit; }
    .type-toggle:hover { background: #fafafa; }
    .chevron { flex-shrink: 0; width: 16px; color: #a1a1aa; font-size: 12px; margin-top: 2px; }
    .type-head { flex: 1; min-width: 0; }
    .type-title { display: block; margin-bottom: 4px; }
    .badge { font-size: 0.75rem; font-weight: normal; color: #71717a; margin-left: 8px; }
    .summary { margin: 0; font-size: 0.875rem; color: #52525b; line-height: 1.5; }
    .type-panel { padding: 0 16px 12px 40px; background: rgba(250,250,250,0.8); border-top: 1px solid #f4f4f5; }
    .type-panel[hidden] { display: none; }
    .panel-label { margin: 10px 0 8px; font-size: 0.8125rem; color: #71717a; font-weight: 600; }
    .bug-list { list-style: none; margin: 0; padding: 0; font-size: 0.875rem; }
    .bug-list li { padding: 8px 0; border-bottom: 1px solid #f4f4f5; }
    .bug-list li:last-child { border-bottom: none; }
    .bug-idx { color: #a1a1aa; margin-right: 6px; }
    .muted { color: #a1a1aa; font-size: 0.875rem; margin: 0; }
    @media print { body { background: #fff; padding: 16px; } .card { break-inside: avoid; } .pie-tooltip { display: none !important; } .type-panel[hidden] { display: block !important; } }
  </style>
</head>
<body>
  <h1>缺陷分析报告</h1>
  <p class="meta">生成时间：${escapeHtml(generatedAt)}${sourceFileName ? ` · 数据来源：${escapeHtml(sourceFileName)}` : ""} · 同类缺陷合计：${total}</p>

  <div class="card">
    <h2>缺陷类型分布</h2>
    <div class="chart-row">
      <div class="chart-wrap" id="chart-wrap">
        <svg id="pie-svg" width="320" height="320" viewBox="0 0 320 320" role="img" aria-label="缺陷类型扇形图">
          ${piePaths}
          ${total > 0 ? `<text x="160" y="152" text-anchor="middle" font-size="14" font-weight="600" fill="#3f3f46">合计</text><text x="160" y="172" text-anchor="middle" font-size="13" fill="#71717a">${total}</text>` : ""}
        </svg>
        <div id="pie-tooltip" class="pie-tooltip" role="tooltip"></div>
      </div>
      <ul class="legend" id="pie-legend">${legend}</ul>
    </div>
  </div>

  <div class="card">
    <h2>统计汇总</h2>
    <table>
      <thead><tr><th>缺陷类型</th><th>同类缺陷合计</th><th>占比</th></tr></thead>
      <tbody>${statRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>各类型缺陷总结</h2>
    <ul class="type-list">${typeSections}</ul>
  </div>

  <script id="pie-data" type="application/json">${pieJson}</script>
  <script>${DEFECT_ANALYSIS_REPORT_SCRIPT}</script>
</body>
</html>`;
}

function downloadAnalysisHtmlReport(
  groups: TypeGroup[],
  sourceFileName: string | null,
) {
  const html = buildAnalysisHtmlReport(groups, sourceFileName);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const date = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `缺陷分析报告_${date}.html`);
}

export function DefectAnalysisClient() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<DefectAnalysisRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
  const [hoveredType, setHoveredType] = useState<string | null>(null);
  const [pieTooltip, setPieTooltip] = useState<{
    x: number;
    y: number;
    type: string;
    value: number;
    percent: number;
  } | null>(null);

  const groups = useMemo(
    () => (rows ? groupByDefectType(rows) : []),
    [rows],
  );
  const totalCount = useMemo(
    () => groups.reduce((s, g) => s + g.totalCount, 0),
    [groups],
  );
  const pieSlices = useMemo(
    () => buildPieSlices(groups, 240, hoveredType),
    [groups, hoveredType],
  );

  const groupByType = useMemo(() => {
    const m = new Map<string, TypeGroup>();
    for (const g of groups) m.set(g.defectType, g);
    return m;
  }, [groups]);

  const onImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setErr(null);
      try {
        const parsed = parseDefectAnalysisExcel(await file.arrayBuffer());
        if ("error" in parsed) {
          setErr(parsed.error);
          return;
        }
        setRows(parsed);
        setFileName(file.name);
        setExpandedTypes(new Set());
        setHoveredType(null);
        setPieTooltip(null);
      } catch {
        setErr("无法读取文件。");
      }
    },
    [],
  );

  const toggleExpanded = useCallback((type: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const onDownloadHtmlReport = useCallback(() => {
    if (!groups.length) return;
    downloadAnalysisHtmlReport(groups, fileName);
  }, [groups, fileName]);

  const onExportExcel = useCallback(() => {
    if (!rows?.length) return;
    exportAnalysisExcel(rows);
  }, [rows]);

  return (
    <ModuleWorkspaceCard>
      <div className="border-b border-zinc-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={onImportFile}
          />
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_SECONDARY}
            onClick={() => fileRef.current?.click()}
          >
            上传 Excel
          </button>
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_SECONDARY}
            disabled={!rows?.length}
            onClick={onExportExcel}
          >
            导出数据
          </button>
          <button
            type="button"
            className={MODULE_TOOLBAR_BTN_PRIMARY}
            disabled={!rows?.length}
            onClick={onDownloadHtmlReport}
          >
            下载报告
          </button>
          {fileName ? (
            <span className="text-sm text-zinc-500">
              已加载：<span className="text-zinc-700">{fileName}</span>
              {rows ? `（${rows.length} 行）` : null}
            </span>
          ) : null}
        </div>
        {err ? (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {err}
          </p>
        ) : null}
      </div>

      {!rows?.length ? (
        <div className="px-4 py-16 text-center text-sm text-zinc-500">
          <p>请上传 Excel 文件开始分析。</p>
          <p className="mt-2 text-xs text-zinc-400">
            表头须包含：bug简述、同类缺陷个数、缺陷类型、缺陷总结
          </p>
        </div>
      ) : (
        <div className="space-y-8 p-4">
          <section aria-label="缺陷类型扇形统计">
            <h2 className="mb-3 text-sm font-medium text-zinc-800">
              缺陷类型分布（按同类缺陷个数）
            </h2>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <div
                className="relative shrink-0"
                onMouseLeave={() => {
                  setHoveredType(null);
                  setPieTooltip(null);
                }}
              >
                <svg
                  width={240}
                  height={240}
                  viewBox="0 0 240 240"
                  className="shrink-0"
                  role="img"
                  aria-label="缺陷类型扇形图"
                >
                  {pieSlices.map((s) => {
                    const active = hoveredType === s.defectType;
                    return (
                      <path
                        key={s.defectType}
                        d={s.path}
                        fill={s.color}
                        stroke="#fff"
                        strokeWidth={active ? 2 : 1}
                        className="cursor-pointer transition-[d,opacity] duration-200"
                        style={{
                          opacity: hoveredType && !active ? 0.72 : 1,
                          filter: active
                            ? "drop-shadow(0 2px 6px rgba(0,0,0,0.18))"
                            : undefined,
                        }}
                        onMouseEnter={(e) => {
                          setHoveredType(s.defectType);
                          const rect = e.currentTarget
                            .closest("svg")
                            ?.getBoundingClientRect();
                          if (rect) {
                            const cx = 120;
                            const cy = 120;
                            const r = 104;
                            setPieTooltip({
                              x:
                                rect.left +
                                cx +
                                r * 0.65 * Math.cos(s.midAngle),
                              y:
                                rect.top +
                                cy +
                                r * 0.65 * Math.sin(s.midAngle),
                              type: s.defectType,
                              value: s.value,
                              percent: s.percent,
                            });
                          }
                        }}
                        onMouseMove={(e) => {
                          setPieTooltip((prev) =>
                            prev?.type === s.defectType
                              ? { ...prev, x: e.clientX, y: e.clientY }
                              : prev,
                          );
                        }}
                      />
                    );
                  })}
                  {totalCount > 0 ? (
                    <text
                      x="120"
                      y="114"
                      textAnchor="middle"
                      className="pointer-events-none fill-zinc-700 font-semibold"
                      style={{ fontSize: 13 }}
                    >
                      合计
                    </text>
                  ) : null}
                  {totalCount > 0 ? (
                    <text
                      x="120"
                      y="132"
                      textAnchor="middle"
                      className="pointer-events-none fill-zinc-500"
                      style={{ fontSize: 12 }}
                    >
                      {totalCount}
                    </text>
                  ) : null}
                </svg>
                {pieTooltip ? (
                  <div
                    className="pointer-events-none fixed z-50 max-w-xs -translate-x-1/2 -translate-y-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs shadow-lg"
                    style={{
                      left: pieTooltip.x,
                      top: pieTooltip.y - 8,
                    }}
                  >
                    <div className="font-medium text-zinc-900">
                      {pieTooltip.type}
                    </div>
                    <div className="mt-0.5 text-zinc-600">
                      同类缺陷 {pieTooltip.value} 个 ·{" "}
                      {pieTooltip.percent.toFixed(1)}%
                    </div>
                    {groupByType.get(pieTooltip.type)?.defectSummary ? (
                      <p className="mt-1 line-clamp-3 text-zinc-500">
                        {groupByType.get(pieTooltip.type)!.defectSummary}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <ul className="min-w-0 flex-1 space-y-1.5 text-sm">
                {pieSlices.map((s) => {
                  const active = hoveredType === s.defectType;
                  return (
                    <li
                      key={s.defectType}
                      className={[
                        "flex cursor-default items-start gap-2 rounded-md px-1 py-0.5 transition-colors",
                        active ? "bg-zinc-100" : "",
                      ].join(" ")}
                      onMouseEnter={() => setHoveredType(s.defectType)}
                      onMouseLeave={() => setHoveredType(null)}
                    >
                      <span
                        className="mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: s.color }}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-zinc-800">
                          {s.defectType}
                        </span>
                        <span className="text-zinc-500">
                          {" "}
                          — {s.value}（{s.percent.toFixed(1)}%）
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <section
              className="mt-8"
              aria-label="按缺陷类型查看总结与 bug 简述"
            >
              <h2 className="mb-3 text-sm font-medium text-zinc-800">
                各类型缺陷总结
              </h2>
              <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                {groups.map((g) => {
                  const open = expandedTypes.has(g.defectType);
                  const listBugs = g.bugs.filter((b) => b.brief.trim());
                  const bugCount = listBugs.length;
                  return (
                    <li key={g.defectType} className="bg-white">
                      <button
                        type="button"
                        className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-zinc-50"
                        onClick={() => toggleExpanded(g.defectType)}
                        aria-expanded={open}
                        onMouseEnter={() => setHoveredType(g.defectType)}
                        onMouseLeave={() => setHoveredType(null)}
                      >
                        <span
                          className="mt-0.5 shrink-0 text-zinc-400"
                          aria-hidden
                        >
                          {open ? "▼" : "▶"}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="font-medium text-zinc-900">
                            {g.defectType}
                          </span>
                          <span className="ml-2 text-xs text-zinc-500">
                            同类缺陷 {g.totalCount} 个 · {bugCount} 条简述
                          </span>
                          {g.defectSummary ? (
                            <p className="mt-1 text-sm leading-relaxed text-zinc-600 whitespace-pre-wrap">
                              {g.defectSummary}
                            </p>
                          ) : (
                            <p className="mt-1 text-sm text-zinc-400">
                              （无缺陷总结）
                            </p>
                          )}
                        </span>
                      </button>
                      {open ? (
                        <ul className="border-t border-zinc-100 bg-zinc-50/80 px-4 py-2 pl-10">
                          {bugCount === 0 ? (
                            <li className="py-2 text-sm text-zinc-400">
                              无 bug 简述
                            </li>
                          ) : (
                            listBugs.map((b, idx) => (
                              <li
                                key={`${g.defectType}-${idx}-${b.brief.slice(0, 40)}`}
                                className="border-b border-zinc-100 py-2 text-sm last:border-0"
                              >
                                <span className="mr-1.5 text-zinc-400">
                                  {idx + 1}.
                                </span>
                                <span className="text-zinc-800 whitespace-pre-wrap">
                                  {b.brief || "（空）"}
                                </span>
                              </li>
                            ))
                          )}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          </section>
        </div>
      )}
    </ModuleWorkspaceCard>
  );
}
