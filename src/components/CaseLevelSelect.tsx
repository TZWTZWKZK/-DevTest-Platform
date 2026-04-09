"use client";

/**
 * 用例等级 L0–L4，对应库内整数 0–4；空值为未设置。
 */
export function CaseLevelSelect({
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
  const safe =
    value === "" || (value.length === 1 && value >= "0" && value <= "4")
      ? value
      : "";
  return (
    <select
      disabled={disabled}
      className={className}
      value={safe}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">未设置</option>
      {[0, 1, 2, 3, 4].map((n) => (
        <option key={n} value={String(n)}>
          L{n}
        </option>
      ))}
    </select>
  );
}
