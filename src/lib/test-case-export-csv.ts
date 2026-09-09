import {
  TEST_CASE_EXPORT_COLUMN_LABELS,
  type TestCaseExportColumnKey,
} from "@/hooks/useTestCaseListColumns";
import type { TestCaseExportRow } from "@/app/actions/test-cases";

function csvEscapeCell(val: string): string {
  const s = String(val).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 与 folderPathFromFlat 一致：用 " / " 连接 */
const FOLDER_PATH_SEP = " / ";

const CN_DIGITS = [
  "零",
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
] as const;

/** 1 → 一，10 → 十，11 → 十一，20 → 二十，21 → 二十一 */
function chineseOrdinal(n: number): string {
  if (n <= 0) return String(n);
  if (n < 10) return CN_DIGITS[n]!;
  if (n === 10) return "十";
  if (n < 20) return `十${CN_DIGITS[n - 10]!}`;
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return ones === 0
      ? `${CN_DIGITS[tens]!}十`
      : `${CN_DIGITS[tens]!}十${CN_DIGITS[ones]!}`;
  }
  return String(n);
}

export function folderLevelColumnLabel(levelIndex: number): string {
  return `${chineseOrdinal(levelIndex + 1)}级目录`;
}

export function splitFolderPathLevels(folderPath: string): string[] {
  const raw = (folderPath ?? "").trim();
  if (!raw) return [];
  return raw.split(FOLDER_PATH_SEP).map((p) => p.trim()).filter(Boolean);
}

/**
 * 导出 CSV：勾选「所在目录」时，按根→叶拆成「第一目录 / 第二目录 / …」多列；
 * 列数取本批数据中路径的最大层级。
 */
export function buildTestCaseExportCsv(
  rows: TestCaseExportRow[],
  fields: readonly TestCaseExportColumnKey[],
): string {
  const maxFolderDepth = fields.includes("folderPath")
    ? rows.reduce(
        (max, row) => Math.max(max, splitFolderPathLevels(row.folderPath).length),
        0,
      )
    : 0;

  const headerParts: string[] = [];
  for (const k of fields) {
    if (k === "folderPath") {
      const depth = Math.max(maxFolderDepth, 1);
      for (let i = 0; i < depth; i++) {
        headerParts.push(csvEscapeCell(folderLevelColumnLabel(i)));
      }
    } else {
      headerParts.push(csvEscapeCell(TEST_CASE_EXPORT_COLUMN_LABELS[k]));
    }
  }

  const bodyLines = rows.map((row) => {
    const levels = splitFolderPathLevels(row.folderPath);
    const cells: string[] = [];
    for (const k of fields) {
      if (k === "folderPath") {
        const depth = Math.max(maxFolderDepth, 1);
        for (let i = 0; i < depth; i++) {
          cells.push(csvEscapeCell(levels[i] ?? ""));
        }
      } else {
        cells.push(csvEscapeCell(row[k] ?? ""));
      }
    }
    return cells.join(",");
  });

  return `\uFEFF${[headerParts.join(","), ...bodyLines].join("\r\n")}`;
}

export function downloadTestCaseExportCsv(
  csv: string,
  filenamePrefix = "用例导出",
): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
