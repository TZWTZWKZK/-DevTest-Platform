"use client";

import { requirementPrioritySelectVisualClass } from "@/lib/requirement-priority";

const STANDARD = new Set(["", "1", "2", "3"]);

/** 需求优先级：低(1)、中(2)、高(3)；空为未设置。非标准数值（历史数据）保留「其他」选项。 */
export function RequirementPrioritySelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const legacy = value !== "" && !STANDARD.has(value);
  const visual = requirementPrioritySelectVisualClass(value);
  return (
    <select
      disabled={disabled}
      className={[visual, className].filter(Boolean).join(" ")}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">未设置</option>
      {legacy ? (
        <option value={value}>其他：{value}</option>
      ) : null}
      <option value="3">高</option>
      <option value="2">中</option>
      <option value="1">低</option>
    </select>
  );
}
