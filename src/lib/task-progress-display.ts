/**
 * 从任务进度文案解析 0–100 的百分比。
 * - 含 % 或大于 1 的数：按字面百分比（如 30、30%）
 * - (0,1] 的小数：按占比（如 0.1 → 10%，1 → 100%）
 */
export function parseTaskProgressPercent(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const hadPercent = s.includes("%");
  const n = Number.parseFloat(s.replace(/%/g, "").replace(/,/g, "").trim());
  if (Number.isNaN(n)) return null;
  if (hadPercent) return Math.min(100, Math.max(0, n));
  if (n > 0 && n <= 1) return Math.min(100, Math.max(0, n * 100));
  return Math.min(100, Math.max(0, n));
}

/**
 * 若整段文案可解析为进度百分比，则统一格式化为「数字%」展示与存储；
 * 无法解析为数字进度（如阶段描述）时保持原文。
 */
export function formatTaskProgressAsPercentIfNumeric(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const pct = parseTaskProgressPercent(s);
  if (pct === null) return s;
  const r = Math.round(pct * 100) / 100;
  if (Number.isInteger(r)) return `${r}%`;
  const str = r
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `${str}%`;
}

export function taskProgressPercentColorClass(pct: number): string {
  if (pct >= 100) return "text-emerald-600";
  if (pct >= 61) return "text-blue-600";
  if (pct >= 31) return "text-amber-600";
  return "text-red-600";
}

/** 椭圆形（胶囊）边框 + 淡色底，与进度分段一致 */
export function taskProgressPercentPillClass(pct: number): string {
  if (pct >= 100) {
    return "border-emerald-500/80 bg-emerald-50 text-emerald-800 ring-1 ring-emerald-500/20";
  }
  if (pct >= 61) {
    return "border-blue-500/80 bg-blue-50 text-blue-800 ring-1 ring-blue-500/20";
  }
  if (pct >= 31) {
    return "border-amber-500/80 bg-amber-50 text-amber-900 ring-1 ring-amber-500/20";
  }
  return "border-red-500/80 bg-red-50 text-red-800 ring-1 ring-red-500/20";
}
