/** 用例等级：库内 0–4 对应界面 L0–L4 */

export function parseCaseLevelOrNull(
  priority: number | null | undefined,
): number | null {
  if (priority === null || priority === undefined) return null;
  const n = Number(priority);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < 0 || n > 4) return null;
  return n;
}

/** 列表/单元格：无效或未设置为空字符串 */
export function formatCaseLevelDisplay(
  priority: number | null | undefined,
): string {
  const n = parseCaseLevelOrNull(priority);
  return n === null ? "" : `L${n}`;
}

/** 表单受控值：仅 0–4 有值，否则空 */
export function caseLevelToFormValue(
  priority: number | null | undefined,
): string {
  const n = parseCaseLevelOrNull(priority);
  return n === null ? "" : String(n);
}

/** 操作记录等：无效值单独标注，便于区分历史脏数据 */
export function formatCaseLevelOpLog(p: number | null | undefined): string {
  if (p === null || p === undefined) return "（空）";
  const n = Number(p);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 4) {
    return `无效(${String(p)})`;
  }
  return `L${n}`;
}
