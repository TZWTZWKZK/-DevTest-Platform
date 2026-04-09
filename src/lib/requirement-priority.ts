/** 需求优先级：库中存 1=低、2=中、3=高；null=未设置。历史 4、5 视为「高」。 */

export function requirementPriorityLabel(p: number | null | undefined): string {
  if (p === null || p === undefined) return "—";
  if (p >= 4 || p === 3) return "高";
  if (p === 2) return "中";
  if (p === 1) return "低";
  return `（${p}）`;
}

export function formatRequirementPriorityExport(
  p: number | null | undefined,
): string {
  if (p === null || p === undefined) return "";
  if (p >= 4 || p === 3) return "高";
  if (p === 2) return "中";
  if (p === 1) return "低";
  return String(p);
}

/** 列表/表单中优先级下拉的配色：未设置灰、高深红、中橘黄、低青蓝、其他浅灰 */
export function requirementPrioritySelectVisualClass(value: string): string {
  const base =
    "rounded-full border px-2 py-0.5 text-xs font-medium outline-none transition-colors focus:ring-2 focus:ring-zinc-400/50 focus:ring-offset-1";
  const v = value.trim();
  if (!v) {
    return `${base} border-zinc-400/80 bg-zinc-100 text-zinc-600`;
  }
  if (v === "3") {
    return `${base} border-red-500/80 bg-red-50 text-red-800`;
  }
  if (v === "2") {
    return `${base} border-amber-500/85 bg-amber-50 text-amber-950`;
  }
  if (v === "1") {
    return `${base} border-sky-600/85 bg-sky-50 text-sky-950`;
  }
  return `${base} border-zinc-400/80 bg-zinc-50 text-zinc-700`;
}

/** 导入：支持 高/中/低、1–3；旧数据 4、5 归为高。 */
export function parseRequirementPriorityImport(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (s === "高") return 3;
  if (s === "中") return 2;
  if (s === "低") return 1;
  const n = Number.parseInt(s, 10);
  if (Number.isNaN(n)) return null;
  if (n >= 4) return 3;
  if (n >= 1 && n <= 3) return n;
  return null;
}
