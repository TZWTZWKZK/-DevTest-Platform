import type { RequirementStatus } from "@prisma/client";

export const requirementStatusLabel: Record<RequirementStatus, string> = {
  UNASSIGNED: "未分配",
  IN_DEVELOPMENT: "开发中",
  IN_RD: "研发中",
  PENDING_VERIFICATION: "待验证",
  CLOSED: "已上线",
};

export const requirementStatusBadgeClass: Record<RequirementStatus, string> = {
  UNASSIGNED: "border-violet-500/80 bg-violet-50 text-violet-800",
  IN_DEVELOPMENT: "border-red-500/80 bg-red-50 text-red-800",
  IN_RD: "border-orange-500/80 bg-orange-50 text-orange-800",
  PENDING_VERIFICATION: "border-emerald-500/80 bg-emerald-50 text-emerald-800",
  CLOSED: "border-blue-500/80 bg-blue-50 text-blue-800",
};

/** 导入/导出与中文状态互转 */
export const REQUIREMENT_STATUS_ZH_TO_ENUM: Record<string, RequirementStatus> =
  {
    未分配: "UNASSIGNED",
    未开始: "UNASSIGNED",
    开发中: "IN_DEVELOPMENT",
    进行中: "IN_DEVELOPMENT",
    研发中: "IN_RD",
    待验证: "PENDING_VERIFICATION",
    已完成: "PENDING_VERIFICATION",
    已上线: "CLOSED",
  };

/** 导入 Excel 状态列：未识别值默认视为开发中（进行中） */
export function parseRequirementStatusImport(raw: string): RequirementStatus {
  const s = raw.trim();
  if (!s) return "UNASSIGNED";
  if (
    s === "UNASSIGNED" ||
    s === "IN_DEVELOPMENT" ||
    s === "IN_RD" ||
    s === "PENDING_VERIFICATION" ||
    s === "CLOSED"
  ) {
    return s;
  }
  return REQUIREMENT_STATUS_ZH_TO_ENUM[s] ?? "IN_DEVELOPMENT";
}
