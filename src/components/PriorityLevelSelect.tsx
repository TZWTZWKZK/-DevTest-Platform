"use client";

const STANDARD = new Set(["", "1", "2", "3", "4", "5"]);

/**
 * 优先级 1–5 分级下拉；空值为未设置。若当前值为非标准数字（历史数据），保留「其他：x」选项直至用户改选。
 */
export function PriorityLevelSelect({
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
  return (
    <select
      disabled={disabled}
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">未设置</option>
      {legacy ? (
        <option value={value}>其他：{value}</option>
      ) : null}
      {[1, 2, 3, 4, 5].map((n) => (
        <option key={n} value={String(n)}>
          {n} 级
        </option>
      ))}
    </select>
  );
}
