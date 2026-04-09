import type { TestCaseStatus, TestDesignType } from "@prisma/client";

export const testDesignTypeLabel: Record<TestDesignType, string> = {
  FUNCTIONAL: "功能",
  PERFORMANCE: "性能",
  SECURITY: "安全",
  COMPATIBILITY: "兼容性",
  USABILITY: "易用性",
  RELIABILITY: "可用可靠性",
  OTHER: "其他",
};

export const testCaseStatusLabel: Record<TestCaseStatus, string> = {
  PASSED: "通过",
  FAILED: "失败",
  BLOCKED: "阻塞",
  DEPRECATED: "废弃",
};

/** 列表中等徽章：描边 + 文字色（Tailwind） */
export const testCaseStatusBadgeClass: Record<TestCaseStatus, string> = {
  PASSED:
    "border-emerald-500/80 bg-emerald-50 text-emerald-800",
  FAILED:
    "border-red-500/80 bg-red-50 text-red-800",
  BLOCKED:
    "border-amber-500/80 bg-amber-50 text-amber-900",
  DEPRECATED:
    "border-zinc-400 bg-zinc-100 text-zinc-600",
};

export const testCaseStatusOptions = Object.entries(testCaseStatusLabel).map(
  ([value, label]) => ({ value: value as TestCaseStatus, label }),
);

export const testDesignTypeOptions = Object.entries(testDesignTypeLabel).map(
  ([value, label]) => ({ value: value as TestDesignType, label }),
);
