const BEIJING_TZ = "Asia/Shanghai";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

/**
 * 将 ISO 时间按北京时间格式化显示（不依赖系统时区）。
 * - withSeconds: 是否显示秒
 */
export function formatIsoBeijing(
  iso: string | null | undefined,
  opts?: { withSeconds?: boolean },
): string {
  const s = (iso ?? "").trim();
  if (!s) return "";
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: BEIJING_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(opts?.withSeconds ? { second: "2-digit" } : {}),
    }).format(d);
  } catch {
    return s;
  }
}

/**
 * 将 ISO 转为 datetime-local 输入值（按北京时间展示）。
 * 输出：YYYY-MM-DDTHH:mm
 */
export function isoToBeijingDatetimeLocal(iso: string | null | undefined): string {
  const s = (iso ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const pick = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";
  const y = pick("year");
  const m = pick("month");
  const day = pick("day");
  const hh = pick("hour");
  const mm = pick("minute");
  if (!y || !m || !day || !hh || !mm) return "";
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

/**
 * 将 datetime-local（视为北京时间）转换成 ISO（UTC）。
 * 输入：YYYY-MM-DDTHH:mm（或带秒）
 */
export function beijingDatetimeLocalToIsoOrNull(v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = m[6] ? Number(m[6]) : 0;
  if (
    !Number.isFinite(y) ||
    !Number.isFinite(mo) ||
    !Number.isFinite(d) ||
    !Number.isFinite(hh) ||
    !Number.isFinite(mm) ||
    !Number.isFinite(ss)
  ) {
    return null;
  }
  // 北京时间固定 UTC+8，无夏令时：转成 UTC 需减 8 小时
  const utcMs = Date.UTC(y, mo - 1, d, hh - 8, mm, ss, 0);
  const dt = new Date(utcMs);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

/**
 * 返回当天日期（北京时间）YYYY-MM-DD，用于文件名/默认值等。
 */
export function beijingTodayYmd(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";
  const y = pick("year");
  const m = pick("month");
  const d = pick("day");
  if (!y || !m || !d) {
    // 兜底：用本地时间
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }
  return `${y}-${m}-${d}`;
}

/** 将 ISO 转为北京时间日期 YYYY-MM-DD（用于 date input / 过滤键等）。 */
export function isoToBeijingYmd(iso: string | null | undefined): string {
  const s = (iso ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: BEIJING_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const pick = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? "";
  const y = pick("year");
  const m = pick("month");
  const day = pick("day");
  return y && m && day ? `${y}-${m}-${day}` : "";
}

