/** 压测 summary.csv 原始行 */
export type PerformanceSummaryRawRow = {
  uri: string;
  method: string;
  /** 原始 status 文本；无法解析数字时仍保留字符串 */
  statusRaw: string;
  status: number | null;
  latencyMs: number | null;
  responseLength: number | null;
  localTime: string;
};

/** 按 uri + method 聚合后的报告行 */
export type PerformanceReportRow = {
  uri: string;
  method: string;
  totalCount: number;
  status200Rate: number;
  status429Rate: number;
  /** 该接口全部 status 占比（按 status 升序） */
  statusBreakdown: Array<{
    status: string;
    count: number;
    rate: number;
  }>;
  latencyAvgMs: number | null;
  latencyMaxMs: number | null;
  responseLengthMax: number | null;
  responseLengthMin: number | null;
  /** localTime 最小值 - 最大值 */
  localTimeRange: string;
};

export const PERFORMANCE_REPORT_HEADERS = [
  "URI",
  "Method",
  "总请求数",
  "200占比",
  "429占比",
  "平均耗时(ms)",
  "最大耗时(ms)",
  "最大响应长度",
  "最小响应长度",
  "时间范围",
] as const;

const REQUIRED_COLS = [
  "uri",
  "method",
  "status",
  "responseLength",
  "localTime",
] as const;

function normalizeHeaderKey(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^\uFEFF/, "")
    .toLowerCase();
}

function parseOptionalNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 简易 CSV 行拆分（支持引号包裹） */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsvText(text: string): string[][] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n").filter((l) => l.trim().length > 0);
  return lines.map(splitCsvLine);
}

export function parsePerformanceSummaryCsv(
  text: string,
): PerformanceSummaryRawRow[] | { error: string } {
  const matrix = parseCsvText(text);
  if (matrix.length < 2) {
    return { error: "CSV 为空或缺少数据行" };
  }
  const headerRow = matrix[0]!;
  const colIndex = new Map<string, number>();
  headerRow.forEach((h, i) => {
    const key = normalizeHeaderKey(h);
    if (key) colIndex.set(key, i);
  });
  for (const col of REQUIRED_COLS) {
    if (colIndex.get(normalizeHeaderKey(col)) === undefined) {
      return {
        error: `缺少必要列「${col}」。请上传压测 summary.csv（需含 uri/method/status/responseLength/localTime；latencyMs 可为空或缺失）。`,
      };
    }
  }

  const rows: PerformanceSummaryRawRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const cells = matrix[r]!;
    const get = (name: string) => {
      const i = colIndex.get(normalizeHeaderKey(name));
      if (i === undefined) return "";
      return String(cells[i] ?? "").trim();
    };
    const uri = get("uri");
    const method = get("method");
    if (!uri && !method) continue;
    const statusRaw = get("status");
    rows.push({
      uri,
      method: method.toUpperCase(),
      statusRaw,
      status: parseOptionalNumber(statusRaw),
      // 允许为空：无列或空单元格 → null，不参与耗时均值/最大值
      latencyMs: parseOptionalNumber(get("latencyMs")),
      responseLength: parseOptionalNumber(get("responseLength")),
      localTime: get("localTime"),
    });
  }
  if (rows.length === 0) {
    return { error: "未解析到有效数据行" };
  }
  return rows;
}

function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function pathParts(relativePath: string): string[] {
  return normalizeRelPath(relativePath).split("/").filter(Boolean);
}

function isSummaryCsvFileName(name: string): boolean {
  return name.trim().toLowerCase() === "summary.csv";
}

/**
 * 是否为「根目录子节点第一层」的 summary.csv：
 * 相对路径形如 `子文件夹名/summary.csv`（恰好两级）。
 */
export function isFirstLevelSummaryCsv(relativePath: string): boolean {
  const parts = pathParts(relativePath);
  return parts.length === 2 && isSummaryCsvFileName(parts[1]!);
}

export type PerformanceSummaryFileHit = {
  folderName: string;
  relativePath: string;
  file: File;
};

export type PerformanceDirectoryScan = {
  /** 根目录下全部子节点（文件夹）名称 */
  childFolders: string[];
  /** 子节点第一层找到的 summary.csv（每个子节点至多一个） */
  found: PerformanceSummaryFileHit[];
  /** 子节点第一层没有 summary.csv 的文件夹名 */
  missingFolders: string[];
};

/**
 * 从「选择压测根目录」得到的文件列表中扫描。
 * 约定：每个子节点文件夹内第一层有且仅检查 `子节点/summary.csv`。
 */
export function scanPerformanceSummaryInDirectory(
  files: FileList | File[],
): PerformanceDirectoryScan {
  const list = Array.from(files);
  const topFolders = new Set<string>();
  const summaryByFolder = new Map<string, PerformanceSummaryFileHit>();

  for (const file of list) {
    const relativePath =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim() ||
      file.name;
    const parts = pathParts(relativePath);
    if (parts.length >= 2) {
      topFolders.add(parts[0]!);
    }

    if (!isFirstLevelSummaryCsv(relativePath)) continue;
    const folderName = parts[0]!;
    // 同一子节点若出现多个同名（异常），保留先遇到的
    if (summaryByFolder.has(folderName)) continue;
    summaryByFolder.set(folderName, {
      folderName,
      relativePath: normalizeRelPath(relativePath),
      file,
    });
  }

  const childFolders = Array.from(topFolders).sort((a, b) =>
    a.localeCompare(b, "zh-CN"),
  );
  const found = childFolders
    .map((name) => summaryByFolder.get(name))
    .filter((x): x is PerformanceSummaryFileHit => Boolean(x));
  const missingFolders = childFolders.filter((name) => !summaryByFolder.has(name));

  return { childFolders, found, missingFolders };
}

export type PerformanceMergedLoadResult = {
  rows: PerformanceSummaryRawRow[];
  loadedFolders: string[];
  missingFolders: string[];
  childFolderTotal: number;
  /** 找到文件但解析失败 */
  parseErrors: Array<{ folderName: string; relativePath: string; error: string }>;
};

/**
 * 按子节点逐个处理：有 summary.csv 则解析合并；没有则记入 missing。
 * onProgress(done, total) 的 total 为子节点总数。
 */
export async function loadMergedPerformanceSummaries(
  files: FileList | File[],
  onProgress?: (done: number, total: number) => void,
): Promise<PerformanceMergedLoadResult> {
  const scan = scanPerformanceSummaryInDirectory(files);
  const summaryByFolder = new Map(
    scan.found.map((h) => [h.folderName, h] as const),
  );
  const rows: PerformanceSummaryRawRow[] = [];
  const loadedFolders: string[] = [];
  const missingFolders: string[] = [];
  const parseErrors: PerformanceMergedLoadResult["parseErrors"] = [];
  const total = scan.childFolders.length;

  onProgress?.(0, total);

  for (let i = 0; i < scan.childFolders.length; i++) {
    const folderName = scan.childFolders[i]!;
    const hit = summaryByFolder.get(folderName);
    if (!hit) {
      missingFolders.push(folderName);
    } else {
      try {
        const text = await hit.file.text();
        const parsed = parsePerformanceSummaryCsv(text);
        if ("error" in parsed) {
          parseErrors.push({
            folderName: hit.folderName,
            relativePath: hit.relativePath,
            error: parsed.error,
          });
        } else {
          rows.push(...parsed);
          loadedFolders.push(hit.folderName);
        }
      } catch (e) {
        parseErrors.push({
          folderName: hit.folderName,
          relativePath: hit.relativePath,
          error: e instanceof Error ? e.message : "读取文件失败",
        });
      }
    }
    onProgress?.(i + 1, total);
    // 让出主线程，便于 UI 刷新进度
    if ((i + 1) % 5 === 0 || i + 1 === total) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  return {
    rows,
    loadedFolders,
    missingFolders,
    childFolderTotal: total,
    parseErrors,
  };
}

/** 是否支持「选目录后只扫/读 summary.csv」（File System Access API） */
export function canUseDirectoryPicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as Window & { showDirectoryPicker?: unknown })
      .showDirectoryPicker === "function"
  );
}

export type PerformanceFsSummaryHit = {
  folderName: string;
  relativePath: string;
  fileHandle: FileSystemFileHandle;
};

export type PerformanceFsScanResult = {
  rootName: string;
  childFolderTotal: number;
  found: PerformanceFsSummaryHit[];
  missingFolders: string[];
};

/**
 * 弹出系统目录选择框，仅遍历根目录的直接子文件夹，
 * 检查各自第一层是否存在 summary.csv（不读取内容、不遍历更深文件）。
 */
export async function scanPerformanceRootViaDirectoryPicker(
  onScanProgress?: (scannedChildren: number) => void,
): Promise<PerformanceFsScanResult | { error: string; aborted?: boolean }> {
  if (!canUseDirectoryPicker()) {
    return {
      error:
        "当前浏览器不支持目录选择器。请使用 Chrome / Edge，或改用「单文件 summary.csv」。",
    };
  }
  let root: FileSystemDirectoryHandle;
  try {
    const picker = (
      window as unknown as {
        showDirectoryPicker: (opts?: {
          id?: string;
          mode?: "read" | "readwrite";
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;
    root = await picker({ id: "pm-perf-root", mode: "read" });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "AbortError") {
      return { error: "已取消选择目录", aborted: true };
    }
    return { error: e instanceof Error ? e.message : "无法打开目录选择器" };
  }

  const found: PerformanceFsSummaryHit[] = [];
  const missingFolders: string[] = [];
  let scanned = 0;

  type DirEntry =
    | { kind: "file"; name: string }
    | { kind: "directory"; name: string; handle: FileSystemDirectoryHandle };

  async function* iterateRootChildren(
    dir: FileSystemDirectoryHandle,
  ): AsyncGenerator<DirEntry> {
    const anyDir = dir as FileSystemDirectoryHandle & {
      values?: () => AsyncIterable<FileSystemHandle>;
      entries?: () => AsyncIterable<[string, FileSystemHandle]>;
    };
    if (typeof anyDir.values === "function") {
      for await (const entry of anyDir.values()) {
        if (entry.kind === "directory") {
          yield {
            kind: "directory",
            name: entry.name,
            handle: entry as FileSystemDirectoryHandle,
          };
        } else {
          yield { kind: "file", name: entry.name };
        }
      }
      return;
    }
    if (typeof anyDir.entries === "function") {
      for await (const [name, entry] of anyDir.entries()) {
        if (entry.kind === "directory") {
          yield {
            kind: "directory",
            name,
            handle: entry as FileSystemDirectoryHandle,
          };
        } else {
          yield { kind: "file", name };
        }
      }
    }
  }

  try {
    // 仅枚举根目录直接子项，不预先加载孙目录里的海量文件
    for await (const entry of iterateRootChildren(root)) {
      if (entry.kind !== "directory") continue;
      const folderName = entry.name;
      scanned += 1;
      onScanProgress?.(scanned);
      try {
        const fileHandle = await entry.handle.getFileHandle("summary.csv");
        found.push({
          folderName,
          relativePath: `${folderName}/summary.csv`,
          fileHandle,
        });
      } catch {
        missingFolders.push(folderName);
      }
      if (scanned % 10 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    }
  } catch (e) {
    return {
      error: e instanceof Error ? e.message : "扫描目录失败",
    };
  }

  found.sort((a, b) => a.folderName.localeCompare(b.folderName, "zh-CN"));
  missingFolders.sort((a, b) => a.localeCompare(b, "zh-CN"));

  return {
    rootName: root.name,
    childFolderTotal: scanned,
    found,
    missingFolders,
  };
}

/**
 * 仅读取已确认的 summary.csv 文件内容并合并（不触碰其它文件）。
 * onProgress(done, total) 的 total 为待读取的 summary.csv 数量。
 */
export async function loadPerformanceSummariesFromFsHits(
  hits: PerformanceFsSummaryHit[],
  missingFolders: string[],
  childFolderTotal: number,
  onProgress?: (done: number, total: number) => void,
): Promise<PerformanceMergedLoadResult> {
  const rows: PerformanceSummaryRawRow[] = [];
  const loadedFolders: string[] = [];
  const parseErrors: PerformanceMergedLoadResult["parseErrors"] = [];
  const total = hits.length;
  onProgress?.(0, total);

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    try {
      const file = await hit.fileHandle.getFile();
      const text = await file.text();
      const parsed = parsePerformanceSummaryCsv(text);
      if ("error" in parsed) {
        parseErrors.push({
          folderName: hit.folderName,
          relativePath: hit.relativePath,
          error: parsed.error,
        });
      } else {
        rows.push(...parsed);
        loadedFolders.push(hit.folderName);
      }
    } catch (e) {
      parseErrors.push({
        folderName: hit.folderName,
        relativePath: hit.relativePath,
        error: e instanceof Error ? e.message : "读取文件失败",
      });
    }
    onProgress?.(i + 1, total);
    if ((i + 1) % 5 === 0 || i + 1 === total) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  return {
    rows,
    loadedFolders,
    missingFolders: [...missingFolders],
    childFolderTotal,
    parseErrors,
  };
}

function formatRate(pct: number): string {
  if (!Number.isFinite(pct)) return "0%";
  const rounded = Math.round(pct * 100) / 100;
  return `${rounded}%`;
}

export function formatStatusBreakdownTooltip(row: PerformanceReportRow): string {
  if (row.statusBreakdown.length === 0) return "暂无 status 数据";
  return row.statusBreakdown
    .map(
      (x) =>
        `status ${x.status}：${formatRate(x.rate)}（${x.count}/${row.totalCount}）`,
    )
    .join("\n");
}

function formatNum(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return String(n);
  return (Math.round(n * 10 ** digits) / 10 ** digits).toString();
}

export function formatPerformanceReportCell(
  row: PerformanceReportRow,
  header: (typeof PERFORMANCE_REPORT_HEADERS)[number],
): string {
  switch (header) {
    case "URI":
      return row.uri;
    case "Method":
      return row.method;
    case "总请求数":
      return String(row.totalCount);
    case "200占比":
      return formatRate(row.status200Rate);
    case "429占比":
      return formatRate(row.status429Rate);
    case "平均耗时(ms)":
      return formatNum(row.latencyAvgMs);
    case "最大耗时(ms)":
      return formatNum(row.latencyMaxMs, 0);
    case "最大响应长度":
      return formatNum(row.responseLengthMax, 0);
    case "最小响应长度":
      return formatNum(row.responseLengthMin, 0);
    case "时间范围":
      return row.localTimeRange || "—";
    default:
      return "";
  }
}

/** status 为空（含仅空白）的行不参与汇总 */
export function isPerformanceRowWithStatus(
  row: PerformanceSummaryRawRow,
): boolean {
  return row.statusRaw.trim() !== "";
}

/** 按 uri + method 聚合（自动剔除 status 为空的数据） */
export function buildPerformanceReport(
  rows: PerformanceSummaryRawRow[],
): PerformanceReportRow[] {
  type Acc = {
    uri: string;
    method: string;
    total: number;
    statusCounts: Map<string, number>;
    latencySum: number;
    latencyCount: number;
    latencyMax: number | null;
    respMax: number | null;
    respMin: number | null;
    timeMin: string;
    timeMax: string;
  };
  const map = new Map<string, Acc>();

  for (const row of rows) {
    if (!isPerformanceRowWithStatus(row)) continue;
    const key = `${row.method}\0${row.uri}`;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        uri: row.uri,
        method: row.method,
        total: 0,
        statusCounts: new Map(),
        latencySum: 0,
        latencyCount: 0,
        latencyMax: null,
        respMax: null,
        respMin: null,
        timeMin: "",
        timeMax: "",
      };
      map.set(key, acc);
    }
    acc.total += 1;
    const statusKey = row.statusRaw.trim();
    acc.statusCounts.set(statusKey, (acc.statusCounts.get(statusKey) ?? 0) + 1);

    if (row.latencyMs !== null) {
      acc.latencySum += row.latencyMs;
      acc.latencyCount += 1;
      acc.latencyMax =
        acc.latencyMax === null
          ? row.latencyMs
          : Math.max(acc.latencyMax, row.latencyMs);
    }
    if (row.responseLength !== null) {
      acc.respMax =
        acc.respMax === null
          ? row.responseLength
          : Math.max(acc.respMax, row.responseLength);
      acc.respMin =
        acc.respMin === null
          ? row.responseLength
          : Math.min(acc.respMin, row.responseLength);
    }
    if (row.localTime) {
      if (!acc.timeMin || row.localTime < acc.timeMin) acc.timeMin = row.localTime;
      if (!acc.timeMax || row.localTime > acc.timeMax) acc.timeMax = row.localTime;
    }
  }

  const out: PerformanceReportRow[] = [];
  for (const acc of map.values()) {
    const localTimeRange =
      acc.timeMin && acc.timeMax
        ? `${acc.timeMin} - ${acc.timeMax}`
        : acc.timeMin || acc.timeMax || "";
    const status200 = acc.statusCounts.get("200") ?? 0;
    const status429 = acc.statusCounts.get("429") ?? 0;
    const statusBreakdown = Array.from(acc.statusCounts.entries())
      .map(([status, count]) => ({
        status,
        count,
        rate: acc.total > 0 ? (count / acc.total) * 100 : 0,
      }))
      .sort((a, b) => {
        const an = Number(a.status);
        const bn = Number(b.status);
        const aNum = Number.isFinite(an);
        const bNum = Number.isFinite(bn);
        if (aNum && bNum) return an - bn;
        if (aNum) return -1;
        if (bNum) return 1;
        return a.status.localeCompare(b.status);
      });
    out.push({
      uri: acc.uri,
      method: acc.method,
      totalCount: acc.total,
      status200Rate: acc.total > 0 ? (status200 / acc.total) * 100 : 0,
      status429Rate: acc.total > 0 ? (status429 / acc.total) * 100 : 0,
      statusBreakdown,
      latencyAvgMs:
        acc.latencyCount > 0 ? acc.latencySum / acc.latencyCount : null,
      latencyMaxMs: acc.latencyMax,
      responseLengthMax: acc.respMax,
      responseLengthMin: acc.respMin,
      localTimeRange,
    });
  }

  out.sort((a, b) => {
    const u = a.uri.localeCompare(b.uri);
    if (u !== 0) return u;
    return a.method.localeCompare(b.method);
  });
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function status200HtmlClass(rate: number): string {
  if (rate < 90) return "tone-red";
  if (rate < 98) return "tone-amber";
  return "tone-green";
}

function latencyAvgHtmlClass(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  if (ms > 1000) return "tone-amber";
  return "tone-green";
}

/** 生成可离线打开的性能分析 HTML 报告 */
export function buildPerformanceReportHtml(
  rows: PerformanceReportRow[],
  options?: { sourceFileName?: string | null; rawCount?: number },
): string {
  const generatedAt = new Date().toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const source = options?.sourceFileName?.trim() || "";
  const rawCount = options?.rawCount ?? 0;

  const thead = PERFORMANCE_REPORT_HEADERS.map(
    (h) => `<th>${escapeHtml(h)}</th>`,
  ).join("");

  const tbody = rows
    .map((row) => {
      const cells = PERFORMANCE_REPORT_HEADERS.map((h) => {
        const text = formatPerformanceReportCell(row, h);
        if (h === "200占比") {
          const tip = escapeHtml(formatStatusBreakdownTooltip(row));
          const cls = status200HtmlClass(row.status200Rate);
          return `<td class="num"><span class="badge ${cls}" title="${tip}">${escapeHtml(text)}</span></td>`;
        }
        if (h === "平均耗时(ms)") {
          const cls = latencyAvgHtmlClass(row.latencyAvgMs);
          return cls
            ? `<td class="num"><span class="badge ${cls}">${escapeHtml(text)}</span></td>`
            : `<td class="num">${escapeHtml(text)}</td>`;
        }
        if (h === "URI" || h === "时间范围") {
          return `<td class="wrap">${escapeHtml(text)}</td>`;
        }
        if (h === "Method") {
          return `<td class="method">${escapeHtml(text)}</td>`;
        }
        return `<td class="num">${escapeHtml(text)}</td>`;
      }).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>性能分析报告</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      padding: 24px;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #18181b;
      background: #fafafa;
      line-height: 1.5;
    }
    h1 { margin: 0 0 8px; font-size: 1.5rem; }
    .meta { margin: 0 0 20px; color: #71717a; font-size: 0.875rem; }
    .card {
      background: #fff;
      border: 1px solid #e4e4e7;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .legend {
      margin: 0;
      padding: 12px 16px;
      border-bottom: 1px solid #f4f4f5;
      font-size: 0.8125rem;
      color: #52525b;
      background: #fafafa;
    }
    .legend span { display: inline-block; margin-right: 12px; }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      margin-right: 4px;
      vertical-align: middle;
    }
    .dot-green { background: #059669; }
    .dot-amber { background: #d97706; }
    .dot-red { background: #dc2626; }
    .table-wrap {
      max-height: min(72vh, calc(100vh - 12rem));
      overflow: auto;
      overscroll-behavior: contain;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
      min-width: 1100px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid #f4f4f5;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: #f4f4f5;
      font-weight: 600;
      color: #52525b;
      font-size: 0.75rem;
      box-shadow: 0 1px 0 0 #e4e4e7;
    }
    tr:hover td { background: #fafafa; }
    td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.method { font-weight: 600; }
    td.wrap { word-break: break-all; font-size: 0.8125rem; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      border: 1px solid transparent;
      font-weight: 600;
    }
    .tone-green { background: #ecfdf5; border-color: #a7f3d0; color: #065f46; }
    .tone-amber { background: #fffbeb; border-color: #fcd34d; color: #92400e; }
    .tone-red { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
    .foot {
      padding: 10px 16px;
      font-size: 0.75rem;
      color: #71717a;
      border-top: 1px solid #f4f4f5;
    }
    @media print {
      body { background: #fff; padding: 12px; }
      .card { box-shadow: none; }
      .table-wrap { max-height: none; overflow: visible; }
      th { position: static; box-shadow: none; }
    }
  </style>
</head>
<body>
  <h1>性能分析报告</h1>
  <p class="meta">
    生成时间：${escapeHtml(generatedAt)}
    ${source ? ` · 数据来源：${escapeHtml(source)}` : ""}
    ${rawCount > 0 ? ` · 原始请求：${rawCount.toLocaleString("zh-CN")} 条` : ""}
    · 接口数：${rows.length}
  </p>
  <div class="card">
    <div class="legend">
      <span><i class="dot dot-green"></i>200占比 ≥98% 或 平均耗时 ≤1000ms</span>
      <span><i class="dot dot-amber"></i>200占比 &lt;98% 或 平均耗时 &gt;1000ms</span>
      <span><i class="dot dot-red"></i>200占比 &lt;90%</span>
      <span>鼠标悬停「200占比」可查看全部 status 占比</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>${thead}</tr></thead>
        <tbody>
${tbody}
        </tbody>
      </table>
    </div>
    <div class="foot">按 URI × Method 汇总（已剔除 status 为空）；时间范围为 localTime 最小值 - 最大值。</div>
  </div>
</body>
</html>`;
}

export function downloadPerformanceReportHtml(
  rows: PerformanceReportRow[],
  options?: { sourceFileName?: string | null; rawCount?: number },
): void {
  const html = buildPerformanceReportHtml(rows, options);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const date = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `性能分析报告_${date}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
