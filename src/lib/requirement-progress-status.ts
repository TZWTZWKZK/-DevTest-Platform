import { parseTaskProgressPercent } from "@/lib/task-progress-display";

/**
 * 按可解析为 0–100% 的任务进度自动建议状态：
 * - 0 < 进度 < 100 → 开发中
 * - 进度 = 100 → 待验证
 * - 无法解析、0、或空 → 不自动改状态（返回 null）
 */
export function deriveRequirementStatusFromTaskProgress(
  raw: string | null | undefined,
): "IN_DEVELOPMENT" | "PENDING_VERIFICATION" | null {
  const pct = parseTaskProgressPercent((raw ?? "").trim());
  if (pct === null) return null;
  const r = Math.round(pct * 100) / 100;
  if (r === 100) return "PENDING_VERIFICATION";
  if (r > 0 && r < 100) return "IN_DEVELOPMENT";
  return null;
}
