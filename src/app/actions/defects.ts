"use server";

// 兼容：本地 Prisma Client 可能尚未 generate 到最新 schema
export type DefectStatus =
  | "UNASSIGNED"
  | "IN_DEVELOPMENT"
  | "TESTING"
  | "CLOSED"
  | "REOPENED";
export type DefectSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type ActionResult = { ok?: true; error?: string };

type LegacyDefectStatus = "NEW" | "IN_PROGRESS" | "RESOLVED" | "CLOSED" | "REJECTED";

function toLegacyStatus(s: DefectStatus): LegacyDefectStatus {
  switch (s) {
    case "UNASSIGNED":
      return "NEW";
    case "IN_DEVELOPMENT":
      return "IN_PROGRESS";
    case "TESTING":
      return "RESOLVED";
    case "CLOSED":
      return "CLOSED";
    case "REOPENED":
      return "REJECTED";
    default:
      return "NEW";
  }
}

function fromDbStatus(s: string): DefectStatus {
  // 新枚举值
  if (
    s === "UNASSIGNED" ||
    s === "IN_DEVELOPMENT" ||
    s === "TESTING" ||
    s === "CLOSED" ||
    s === "REOPENED"
  ) {
    return s;
  }
  // 旧枚举值兼容
  switch (s as LegacyDefectStatus) {
    case "NEW":
      return "UNASSIGNED";
    case "IN_PROGRESS":
      return "IN_DEVELOPMENT";
    case "RESOLVED":
      return "TESTING";
    case "CLOSED":
      return "CLOSED";
    case "REJECTED":
      return "REOPENED";
    default:
      return "UNASSIGNED";
  }
}

function isInvalidEnumValueError(e: unknown, argName: string): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message || "";
  // PrismaClientValidationError 常见提示：Invalid value for argument `status`. Expected DefectStatus.
  return m.includes(`Invalid value for argument \`${argName}\``) && m.includes("Expected");
}

function prismaKnownToMessage(e: Prisma.PrismaClientKnownRequestError): string {
  switch (e.code) {
    case "P2002":
      return "与已有数据冲突（例如缺陷编号不能重复）。";
    case "P2022":
      return "数据库字段与当前程序不一致。请停止开发服务后执行 npx prisma generate，必要时 npx prisma db push，删除 .next 文件夹后重新启动。";
    case "P2021":
      return "缺陷表不存在。请执行 npx prisma db push 或迁移数据库后再试。";
    case "P2025":
      return "记录不存在或已被删除。";
    default:
      return `数据操作未成功（${e.code}），请稍后重试或联系管理员。`;
  }
}

function toUserActionError(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return prismaKnownToMessage(e);
  }
  if (e instanceof Error && e.message) return `操作失败：${e.message}`;
  return "操作失败，请稍后重试。";
}

function genDefectNo(): string {
  const iso = new Date().toISOString().replace(/[-:TZ.]/g, "");
  const rnd = Math.random().toString(16).slice(2, 6).toUpperCase();
  return `DF-${iso}-${rnd}`;
}

const DEFECT_STATUS_LABEL: Record<DefectStatus, string> = {
  UNASSIGNED: "未分配",
  IN_DEVELOPMENT: "开发中",
  TESTING: "测试",
  CLOSED: "已关闭",
  REOPENED: "重开",
};

const DEFECT_SEVERITY_LABEL: Record<DefectSeverity, string> = {
  CRITICAL: "致命",
  HIGH: "严重",
  MEDIUM: "一般",
  LOW: "建议",
};

function clipLogText(s: string | null | undefined, max: number): string {
  if (s == null) return "—";
  const t = String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!t) return "—";
  const oneLine = t.replace(/\n+/g, " ");
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…`;
}

/** Markdown 图片：![alt](src)，src 含 data URL 时不写入操作记录正文 */
const MD_IMAGE_PATTERN = "!\\[([^\\]]*)\\]\\(([^)]+)\\)";

function extractImageSrcsOrdered(md: string): string[] {
  const out: string[] = [];
  const re = new RegExp(MD_IMAGE_PATTERN, "g");
  for (const m of md.matchAll(re)) {
    out.push(String(m[2] ?? "").trim());
  }
  return out;
}

function plainTextStripImages(md: string): string {
  return md
    .replace(new RegExp(MD_IMAGE_PATTERN, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countImageMultisetDelta(
  prev: string[],
  next: string[],
): { added: number; removed: number } {
  const prevM = new Map<string, number>();
  const nextM = new Map<string, number>();
  for (const s of prev) prevM.set(s, (prevM.get(s) ?? 0) + 1);
  for (const s of next) nextM.set(s, (nextM.get(s) ?? 0) + 1);
  let removed = 0;
  let added = 0;
  const keys = new Set([...prevM.keys(), ...nextM.keys()]);
  for (const k of keys) {
    const p = prevM.get(k) ?? 0;
    const n = nextM.get(k) ?? 0;
    removed += Math.max(0, p - n);
    added += Math.max(0, n - p);
  }
  return { added, removed };
}

/** 张数相同时按位置比较 src，计为「修改」；张数不同时用多重集合计新增/删除 */
function diffMarkdownImages(
  prevMd: string,
  nextMd: string,
): { added: number; removed: number; modified: number } {
  const pa = extractImageSrcsOrdered(prevMd);
  const na = extractImageSrcsOrdered(nextMd);
  if (pa.length === na.length) {
    let modified = 0;
    for (let i = 0; i < pa.length; i++) {
      if (pa[i] !== na[i]) modified++;
    }
    return { added: 0, removed: 0, modified };
  }
  const { added, removed } = countImageMultisetDelta(pa, na);
  // 张数不同但「新增=删除」时多为整体替换，合并为「修改」更直观
  if (added === removed && added > 0) {
    return { added: 0, removed: 0, modified: added };
  }
  return { added, removed, modified: 0 };
}

/** 保存前后缺陷描述：正文仍展示摘要；图片仅展示新增/删除/修改张数 */
function formatDescriptionChangeForLog(
  prev: string | null,
  next: string | null,
): string {
  const p = prev ?? "";
  const n = next ?? "";
  const plainP = plainTextStripImages(p);
  const plainN = plainTextStripImages(n);
  const textChanged = plainP !== plainN;
  const { added, removed, modified } = diffMarkdownImages(p, n);
  const imgChanged = added > 0 || removed > 0 || modified > 0;

  const imgSeg = imgChanged
    ? `图片：新增${added}个、删除${removed}个、修改${modified}个`
    : "";

  if (textChanged && imgChanged) {
    return `缺陷描述：正文「${clipLogText(plainP, 80)}」→「${clipLogText(plainN, 80)}」；${imgSeg}`;
  }
  if (textChanged) {
    return `缺陷描述：「${clipLogText(plainP, 80)}」→「${clipLogText(plainN, 80)}」`;
  }
  if (imgChanged) {
    return `缺陷描述：${imgSeg}`;
  }
  if (p !== n) {
    return "缺陷描述：内容有微调（未识别为正文或图片数量/顺序变化）";
  }
  return "";
}

function formatDescriptionSnapshotForCreate(desc: string | null): string {
  const d = desc?.trim() ?? "";
  if (!d) return "—";
  const plain = plainTextStripImages(d);
  const imgN = extractImageSrcsOrdered(d).length;
  if (!plain && imgN > 0) {
    return `共${imgN}张图片`;
  }
  if (plain && imgN === 0) {
    return clipLogText(plain, 120);
  }
  return `正文「${clipLogText(plain, 100)}」；共${imgN}张图片`;
}

function fmtFoundAtLog(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}

function sameFoundAt(a: Date | null, b: Date | null): boolean {
  return fmtFoundAtLog(a) === fmtFoundAtLog(b);
}

async function fmtProductIdForLog(id: string | null): Promise<string> {
  const raw = id?.trim() || "";
  if (!raw) return "—";
  try {
    const p = await prisma.product.findUnique({
      where: { id: raw },
      select: { name: true, code: true },
    });
    if (!p) return raw;
    return p.code ? `${p.name}（${p.code}）` : p.name;
  } catch {
    return raw;
  }
}

type DefectLogSnapshot = {
  name: string;
  status: DefectStatus;
  severity: DefectSeverity;
  iterationCode: string | null;
  caseNo: string | null;
  devOwner: string | null;
  submitter: string | null;
  foundAt: Date | null;
  description: string | null;
  linkedTestId: string | null;
  linkedProject: string | null;
  reopenCount: number;
  updatedBy: string | null;
};

function snapshotFromDbRow(row: {
  name: string;
  status: string;
  severity: DefectSeverity;
  iterationCode: string | null;
  caseNo: string | null;
  devOwner: string | null;
  submitter: string | null;
  foundAt: Date | null;
  description: string | null;
  linkedTestId: string | null;
  linkedProject: string | null;
  reopenCount: number;
  updatedBy: string | null;
}): DefectLogSnapshot {
  return {
    name: row.name,
    status: fromDbStatus(row.status),
    severity: row.severity,
    iterationCode: row.iterationCode?.trim() || null,
    caseNo: row.caseNo?.trim() || null,
    devOwner: row.devOwner?.trim() || null,
    submitter: row.submitter?.trim() || null,
    foundAt: row.foundAt,
    description: row.description?.trim() || null,
    linkedTestId: row.linkedTestId?.trim() || null,
    linkedProject: row.linkedProject?.trim() || null,
    reopenCount: row.reopenCount,
    updatedBy: row.updatedBy?.trim() || null,
  };
}

function snapshotFromSaveInput(
  input: {
    status: DefectStatus;
    severity: DefectSeverity;
    iterationCode: string | null;
    caseNo: string | null;
    devOwner: string | null;
    submitter: string | null;
    description: string | null;
    linkedTestId: string | null;
    linkedProject: string | null;
    reopenCount: number | null;
    updatedBy?: string | null;
  },
  name: string,
  foundAt: Date | null,
): DefectLogSnapshot {
  const reopen =
    input.reopenCount === null || input.reopenCount === undefined
      ? 0
      : Math.max(0, Math.floor(input.reopenCount));
  return {
    name,
    status: input.status,
    severity: input.severity,
    iterationCode: input.iterationCode?.trim() || null,
    caseNo: input.caseNo?.trim() || null,
    devOwner: input.devOwner?.trim() || null,
    submitter: input.submitter?.trim() || null,
    foundAt,
    description: input.description?.trim() || null,
    linkedTestId: input.linkedTestId?.trim() || null,
    linkedProject: input.linkedProject?.trim() || null,
    reopenCount: reopen,
    updatedBy: (input.updatedBy ?? "").trim() || null,
  };
}

async function buildDefectUpdateDetail(
  prev: DefectLogSnapshot,
  next: DefectLogSnapshot,
): Promise<string> {
  const parts: string[] = [];

  if (prev.name !== next.name) {
    parts.push(
      `缺陷名称：「${clipLogText(prev.name, 80)}」→「${clipLogText(next.name, 80)}」`,
    );
  }
  if (prev.status !== next.status) {
    parts.push(
      `状态：「${DEFECT_STATUS_LABEL[prev.status]}」→「${DEFECT_STATUS_LABEL[next.status]}」`,
    );
  }
  if (prev.severity !== next.severity) {
    parts.push(
      `严重等级：「${DEFECT_SEVERITY_LABEL[prev.severity]}」→「${DEFECT_SEVERITY_LABEL[next.severity]}」`,
    );
  }
  if ((prev.iterationCode ?? "") !== (next.iterationCode ?? "")) {
    parts.push(
      `关联迭代：「${clipLogText(prev.iterationCode, 60)}」→「${clipLogText(next.iterationCode, 60)}」`,
    );
  }
  if ((prev.caseNo ?? "") !== (next.caseNo ?? "")) {
    parts.push(
      `用例编号：「${clipLogText(prev.caseNo, 40)}」→「${clipLogText(next.caseNo, 40)}」`,
    );
  }
  if ((prev.devOwner ?? "") !== (next.devOwner ?? "")) {
    parts.push(
      `开发责任人：「${clipLogText(prev.devOwner, 40)}」→「${clipLogText(next.devOwner, 40)}」`,
    );
  }
  if ((prev.submitter ?? "") !== (next.submitter ?? "")) {
    parts.push(
      `提交人：「${clipLogText(prev.submitter, 40)}」→「${clipLogText(next.submitter, 40)}」`,
    );
  }
  if (!sameFoundAt(prev.foundAt, next.foundAt)) {
    parts.push(
      `发现时间：「${fmtFoundAtLog(prev.foundAt)}」→「${fmtFoundAtLog(next.foundAt)}」`,
    );
  }
  const pd = prev.description ?? "";
  const nd = next.description ?? "";
  if (pd !== nd) {
    const line = formatDescriptionChangeForLog(pd, nd);
    if (line) parts.push(line);
  }
  if ((prev.linkedTestId ?? "") !== (next.linkedTestId ?? "")) {
    parts.push(
      `关联测试ID：「${clipLogText(prev.linkedTestId, 40)}」→「${clipLogText(next.linkedTestId, 40)}」`,
    );
  }
  if ((prev.linkedProject ?? "") !== (next.linkedProject ?? "")) {
    const [op, np] = await Promise.all([
      fmtProductIdForLog(prev.linkedProject),
      fmtProductIdForLog(next.linkedProject),
    ]);
    parts.push(`关联产品：「${op}」→「${np}」`);
  }
  if (prev.reopenCount !== next.reopenCount) {
    parts.push(`缺陷重开次数：「${prev.reopenCount}」→「${next.reopenCount}」`);
  }
  if ((prev.updatedBy ?? "") !== (next.updatedBy ?? "")) {
    parts.push(
      `修改人：「${clipLogText(prev.updatedBy, 40)}」→「${clipLogText(next.updatedBy, 40)}」`,
    );
  }

  return parts.length > 0
    ? parts.join("\n")
    : "未检测到字段变更（保存内容可能与上次一致）";
}

async function buildDefectCreateDetail(input: {
  defectNo: string;
  name: string;
  status: DefectStatus;
  severity: DefectSeverity;
  iterationCode: string | null;
  caseNo: string | null;
  devOwner: string | null;
  submitter: string | null;
  foundAt: Date | null;
  description: string | null;
  linkedTestId: string | null;
  linkedProject: string | null;
  reopenCount: number;
  updatedBy: string | null;
}): Promise<string> {
  const prod = await fmtProductIdForLog(input.linkedProject);
  const lines = [
    `缺陷编号：${input.defectNo}`,
    `缺陷名称：${clipLogText(input.name, 80)}`,
    `状态：${DEFECT_STATUS_LABEL[input.status]}`,
    `严重等级：${DEFECT_SEVERITY_LABEL[input.severity]}`,
    `关联迭代：${clipLogText(input.iterationCode, 60)}`,
    `用例编号：${clipLogText(input.caseNo, 40)}`,
    `开发责任人：${clipLogText(input.devOwner, 40)}`,
    `提交人：${clipLogText(input.submitter, 40)}`,
    `发现时间：${fmtFoundAtLog(input.foundAt)}`,
    `关联测试ID：${clipLogText(input.linkedTestId, 40)}`,
    `关联产品：${prod}`,
    `缺陷重开次数：${input.reopenCount}`,
    `修改人：${clipLogText(input.updatedBy, 40)}`,
    `缺陷描述：${formatDescriptionSnapshotForCreate(input.description)}`,
  ];
  return lines.join("\n");
}

async function fmtTestCasesForLog(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.testCase.findMany({
    where: { id: { in: ids } },
    select: { id: true, caseNo: true, title: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const c = byId.get(id);
    if (!c) return id;
    return `${c.caseNo} ${clipLogText(c.title, 50)}`.trim();
  });
}

export type DefectListItem = {
  id: string;
  defectNo: string;
  name: string;
  status: DefectStatus;
  severity: DefectSeverity;
  iterationCode: string | null;
  caseNo: string | null;
  devOwner: string | null;
  submitter: string | null;
  foundAt: string | null;
  description: string | null;
  linkedTestId: string | null;
  linkedProject: string | null;
  reopenCount: number;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DefectLinkedTestCase = {
  id: string;
  caseNo: string;
  title: string;
};

export type DefectOpLogItem = {
  id: string;
  action: string;
  detail: string | null;
  createdAt: string;
};

export async function getDefectFull(defectId: string): Promise<
  | (DefectListItem & {
      linkedTestCases: DefectLinkedTestCase[];
      opLogs: DefectOpLogItem[];
    })
  | null
> {
  const id = defectId.trim();
  if (!id) return null;
  try {
    const row = await prisma.defect.findUnique({
      where: { id },
      select: {
        id: true,
        defectNo: true,
        name: true,
        status: true,
        severity: true,
        iterationCode: true,
        caseNo: true,
        devOwner: true,
        submitter: true,
        foundAt: true,
        description: true,
        linkedTestId: true,
        linkedProject: true,
        reopenCount: true,
        updatedBy: true,
        createdAt: true,
        updatedAt: true,
        linkedCases: {
          orderBy: [{ createdAt: "desc" }],
          select: {
            testCase: { select: { id: true, caseNo: true, title: true } },
          },
        },
        opLogs: {
          orderBy: [{ createdAt: "desc" }],
          take: 200,
          select: { id: true, action: true, detail: true, createdAt: true },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      defectNo: row.defectNo,
      name: row.name,
      status: fromDbStatus(row.status),
      severity: row.severity,
      iterationCode: row.iterationCode,
      caseNo: row.caseNo,
      devOwner: row.devOwner,
      submitter: row.submitter,
      foundAt: row.foundAt ? row.foundAt.toISOString() : null,
      description: row.description,
      linkedTestId: row.linkedTestId,
      linkedProject: row.linkedProject,
      reopenCount: row.reopenCount,
      updatedBy: row.updatedBy ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      linkedTestCases: row.linkedCases.map((x) => x.testCase),
      opLogs: row.opLogs.map((x) => ({
        id: x.id,
        action: x.action,
        detail: x.detail ?? null,
        createdAt: x.createdAt.toISOString(),
      })),
    };
  } catch {
    return null;
  }
}

export async function addDefectLinkedTestCases(
  defectId: string,
  testCaseIds: string[],
): Promise<ActionResult & { createdTestCaseIds?: string[] }> {
  const id = defectId.trim();
  const uniq = Array.from(new Set(testCaseIds.map((x) => x.trim()).filter(Boolean)));
  if (!id) return { error: "无效缺陷" };
  if (uniq.length === 0) return { error: "请选择要关联的用例" };
  try {
    const existed = await prisma.defectTestCase.findMany({
      where: { defectId: id, testCaseId: { in: uniq } },
      select: { testCaseId: true },
    });
    const existedSet = new Set(existed.map((x) => x.testCaseId));
    const toCreate = uniq.filter((tc) => !existedSet.has(tc));
    if (toCreate.length > 0) {
      await prisma.defectTestCase.createMany({
        data: toCreate.map((tc) => ({ defectId: id, testCaseId: tc })),
      });
    }
    if (toCreate.length > 0) {
      const total = await prisma.defectTestCase.count({
        where: { defectId: id },
      });
      const lines = await fmtTestCasesForLog(toCreate);
      const detail = `新增关联 ${toCreate.length} 条\n当前已关联用例总数：${total}\n${lines.join("\n")}`;
      await prisma.defectOpLog.create({
        data: {
          defectId: id,
          action: "LINK_TESTCASES_ADD",
          detail,
        },
        select: { id: true },
      });
    }
    revalidatePath("/defects");
    return { ok: true, createdTestCaseIds: toCreate };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function removeDefectLinkedTestCases(
  defectId: string,
  testCaseIds: string[],
): Promise<ActionResult & { removedCount?: number }> {
  const id = defectId.trim();
  const uniq = Array.from(new Set(testCaseIds.map((x) => x.trim()).filter(Boolean)));
  if (!id) return { error: "无效缺陷" };
  if (uniq.length === 0) return { error: "请选择要移除的关联用例" };
  try {
    const del = await prisma.defectTestCase.deleteMany({
      where: { defectId: id, testCaseId: { in: uniq } },
    });
    if (del.count > 0) {
      const total = await prisma.defectTestCase.count({
        where: { defectId: id },
      });
      const lines = await fmtTestCasesForLog(uniq);
      const detail = `移除关联 ${del.count} 条\n当前已关联用例总数：${total}\n${lines.join("\n")}`;
      await prisma.defectOpLog.create({
        data: {
          defectId: id,
          action: "LINK_TESTCASES_REMOVE",
          detail,
        },
        select: { id: true },
      });
    }
    revalidatePath("/defects");
    return { ok: true, removedCount: del.count };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function replaceDefectLinkedTestCase(
  defectId: string,
  fromTestCaseId: string,
  toTestCaseId: string,
): Promise<ActionResult> {
  const id = defectId.trim();
  const fromId = fromTestCaseId.trim();
  const toId = toTestCaseId.trim();
  if (!id) return { error: "无效缺陷" };
  if (!fromId || !toId) return { error: "请选择要替换的用例" };
  if (fromId === toId) return { ok: true };
  try {
    await prisma.$transaction([
      prisma.defectTestCase.deleteMany({
        where: { defectId: id, testCaseId: fromId },
      }),
      prisma.defectTestCase.create({
        data: { defectId: id, testCaseId: toId },
      }),
    ]);
    const [fromLines, toLines] = await Promise.all([
      fmtTestCasesForLog([fromId]),
      fmtTestCasesForLog([toId]),
    ]);
    const detail = `替换关联：「${fromLines[0] ?? fromId}」→「${toLines[0] ?? toId}」`;
    await prisma.defectOpLog.create({
      data: {
        defectId: id,
        action: "LINK_TESTCASES_REPLACE",
        detail,
      },
      select: { id: true },
    });
    revalidatePath("/defects");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export type DefectLinkOption = {
  id: string;
  defectNo: string;
  name: string;
};

/** 与缺陷弹窗「添加关联用例」一致的轻量搜索，供用例侧反向关联缺陷 */
export async function searchDefectLinkOptions(input: {
  q?: string | null;
  iterationCode?: string | null;
  take?: number | null;
}): Promise<DefectLinkOption[]> {
  const q = (input.q ?? "").trim();
  const iterationCode = (input.iterationCode ?? "").trim();
  const take = Math.max(1, Math.min(200, Number(input.take ?? 20) || 20));
  try {
    const rows = await prisma.defect.findMany({
      where: {
        ...(iterationCode ? { iterationCode } : {}),
        ...(q
          ? {
              OR: [
                { defectNo: { contains: q } },
                { name: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      select: { id: true, defectNo: true, name: true },
      take,
    });
    return rows;
  } catch {
    return [];
  }
}

export async function listDefects(input: {
  q?: string | null;
  status?: string | "" | null;
  severity?: string | "" | null;
  iterationCode?: string | "" | null;
  linkedProject?: string | "" | null;
  devOwner?: string | null;
  submitter?: string | null;
  caseNo?: string | null;
  foundFrom?: string | null; // yyyy-mm-dd
  foundTo?: string | null;
  reopenCountMin?: string | null;
  reopenCountMax?: string | null;
  createdFrom?: string | null;
  createdTo?: string | null;
  updatedFrom?: string | null;
  updatedTo?: string | null;
  updatedBy?: string | null;
}): Promise<DefectListItem[]> {
  const q = (input.q ?? "").trim();
  const statusRaw = String(input.status ?? "").trim();
  const severityRaw = String(input.severity ?? "").trim();
  const iterationCode = String(input.iterationCode ?? "").trim();
  const linkedProject = String(input.linkedProject ?? "").trim();
  const statusNorm = statusRaw ? fromDbStatus(statusRaw) : "";
  const severity =
    severityRaw === "CRITICAL" ||
    severityRaw === "HIGH" ||
    severityRaw === "MEDIUM" ||
    severityRaw === "LOW"
      ? (severityRaw as DefectSeverity)
      : "";
  const devOwner = (input.devOwner ?? "").trim();
  const submitter = (input.submitter ?? "").trim();
  const caseNo = (input.caseNo ?? "").trim();
  const reopenMin = (input.reopenCountMin ?? "").trim();
  const reopenMax = (input.reopenCountMax ?? "").trim();
  const createdFromRaw = (input.createdFrom ?? "").trim();
  const createdToRaw = (input.createdTo ?? "").trim();
  const updatedFromRaw = (input.updatedFrom ?? "").trim();
  const updatedToRaw = (input.updatedTo ?? "").trim();
  const updatedByQ = (input.updatedBy ?? "").trim();

  const toBoundary = (d: string, end: boolean): Date | null => {
    if (!d) return null;
    const dt = new Date(end ? `${d}T23:59:59.999` : `${d}T00:00:00`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  };
  const foundFrom = toBoundary((input.foundFrom ?? "").trim(), false);
  const foundTo = toBoundary((input.foundTo ?? "").trim(), true);
  const createdFrom = toBoundary(createdFromRaw, false);
  const createdTo = toBoundary(createdToRaw, true);
  const updatedFrom = toBoundary(updatedFromRaw, false);
  const updatedTo = toBoundary(updatedToRaw, true);
  const reopenCountMin = reopenMin ? Number.parseInt(reopenMin, 10) : null;
  const reopenCountMax = reopenMax ? Number.parseInt(reopenMax, 10) : null;

  try {
    // 兼容：如果历史数据还残留旧枚举值，先就地迁移到新枚举（避免 Prisma 读取时解析失败）
    try {
      await prisma.$executeRawUnsafe(
        "UPDATE Defect SET status = 'UNASSIGNED' WHERE status = 'NEW'",
      );
      await prisma.$executeRawUnsafe(
        "UPDATE Defect SET status = 'IN_DEVELOPMENT' WHERE status = 'IN_PROGRESS'",
      );
      await prisma.$executeRawUnsafe(
        "UPDATE Defect SET status = 'TESTING' WHERE status = 'RESOLVED'",
      );
      await prisma.$executeRawUnsafe(
        "UPDATE Defect SET status = 'REOPENED' WHERE status = 'REJECTED'",
      );
    } catch {
      // ignore
    }

    const db = prisma as unknown as {
      defect: {
        findMany: (args: unknown) => Promise<unknown[]>;
      };
    };

    const select = {
      id: true,
      defectNo: true,
      name: true,
      status: true,
      severity: true,
      iterationCode: true,
      caseNo: true,
      devOwner: true,
      submitter: true,
      foundAt: true,
      description: true,
      linkedTestId: true,
      linkedProject: true,
      reopenCount: true,
      updatedBy: true,
      createdAt: true,
      updatedAt: true,
    } as const;

    const baseWhere = {
      ...(q
        ? {
            OR: [
              { defectNo: { contains: q } },
              { name: { contains: q } },
              { description: { contains: q } },
              { linkedProject: { contains: q } },
              { linkedTestId: { contains: q } },
              { updatedBy: { contains: q } },
            ],
          }
        : {}),
      ...(iterationCode ? { iterationCode } : {}),
      ...(linkedProject ? { linkedProject } : {}),
      ...(devOwner ? { devOwner: { contains: devOwner } } : {}),
      ...(submitter ? { submitter: { contains: submitter } } : {}),
      ...(updatedByQ ? { updatedBy: { contains: updatedByQ } } : {}),
      ...(caseNo ? { caseNo: { contains: caseNo } } : {}),
      ...(foundFrom || foundTo
        ? { foundAt: { gte: foundFrom ?? undefined, lte: foundTo ?? undefined } }
        : {}),
      ...(createdFrom || createdTo
        ? {
            createdAt: { gte: createdFrom ?? undefined, lte: createdTo ?? undefined },
          }
        : {}),
      ...(updatedFrom || updatedTo
        ? {
            updatedAt: { gte: updatedFrom ?? undefined, lte: updatedTo ?? undefined },
          }
        : {}),
      ...(reopenCountMin !== null || reopenCountMax !== null
        ? {
            reopenCount: {
              gte: reopenCountMin ?? undefined,
              lte: reopenCountMax ?? undefined,
            },
          }
        : {}),
    } as const;

    const argsNew = {
      where: {
        ...baseWhere,
        ...(statusNorm ? { status: statusNorm } : {}),
        ...(severity ? { severity } : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      select,
      take: 1000,
    } as const;

    let rawRows: unknown[];
    try {
      rawRows = await db.defect.findMany(argsNew);
    } catch (e) {
      // 兼容：如果数据库/Prisma Client 仍为旧枚举，回退旧值重试
      if (statusNorm && isInvalidEnumValueError(e, "status")) {
        rawRows = await db.defect.findMany({
          ...argsNew,
          where: {
            ...argsNew.where,
            status: toLegacyStatus(statusNorm),
          },
        });
      } else {
        throw e;
      }
    }

    const rows = rawRows as unknown as Array<{
      id: string;
      defectNo: string;
      name: string;
      status: string;
      severity: DefectSeverity;
      iterationCode: string | null;
      caseNo: string | null;
      devOwner: string | null;
      submitter: string | null;
      foundAt: Date | null;
      description: string | null;
      linkedTestId: string | null;
      linkedProject: string | null;
      reopenCount: number;
      updatedBy: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    return rows.map(
      (r): DefectListItem => ({
        ...r,
        status: fromDbStatus(r.status),
        foundAt: r.foundAt ? r.foundAt.toISOString() : null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }),
    );
  } catch (e) {
    // 表不存在时返回空，避免页面直接炸（同时让前端显示提示）
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2021") {
      return [];
    }
    throw e;
  }
}

export async function saveDefect(input: {
  id?: string | null;
  defectNo?: string | null;
  name: string;
  status: DefectStatus;
  severity: DefectSeverity;
  iterationCode: string | null;
  caseNo: string | null;
  devOwner: string | null;
  submitter: string | null;
  foundAt: string | null; // yyyy-mm-dd
  description: string | null;
  linkedTestId: string | null;
  linkedProject: string | null;
  reopenCount: number | null;
  /** 本次保存者（手填），写入 updatedBy；修改时间由库字段 updatedAt 自动更新 */
  updatedBy?: string | null;
}): Promise<ActionResult & { id?: string }> {
  const name = input.name.trim();
  if (!name) return { error: "缺陷名称不能为空" };

  const foundAt = input.foundAt?.trim()
    ? (() => {
        const d = new Date(`${input.foundAt}T00:00:00`);
        return Number.isNaN(d.getTime()) ? null : d;
      })()
    : null;

  const updatedBy = (input.updatedBy ?? "").trim() || null;

  try {
    const db = prisma as unknown as {
      defect: {
        update: (args: unknown) => Promise<{ id: string }>;
        create: (args: unknown) => Promise<{ id: string }>;
      };
    };
    if (input.id) {
      const id = input.id.trim();
      if (!id) return { error: "无效缺陷" };
      const prevRow = await prisma.defect.findUnique({
        where: { id },
        select: {
          name: true,
          status: true,
          severity: true,
          iterationCode: true,
          caseNo: true,
          devOwner: true,
          submitter: true,
          foundAt: true,
          description: true,
          linkedTestId: true,
          linkedProject: true,
          reopenCount: true,
          updatedBy: true,
        },
      });
      if (!prevRow) return { error: "缺陷不存在或已被删除" };

      const prevSnap = snapshotFromDbRow(prevRow);
      const prevStatus = fromDbStatus(String(prevRow.status));
      /** 仅当 已关闭 → 重开 时自动 +1，其余情况沿用库内值（不接受前端手改） */
      const nextReopenCount =
        prevStatus === "CLOSED" && input.status === "REOPENED"
          ? prevRow.reopenCount + 1
          : prevRow.reopenCount;
      const nextSnap = snapshotFromSaveInput(
        { ...input, reopenCount: nextReopenCount },
        name,
        foundAt,
      );
      const updateDetail = await buildDefectUpdateDetail(prevSnap, nextSnap);

      const updateArgs = {
        where: { id },
        data: {
          name,
          status: input.status,
          severity: input.severity,
          iterationCode: input.iterationCode?.trim() || null,
          caseNo: input.caseNo?.trim() || null,
          devOwner: input.devOwner?.trim() || null,
          submitter: input.submitter?.trim() || null,
          foundAt,
          description: input.description?.trim() || null,
          linkedTestId: input.linkedTestId?.trim() || null,
          linkedProject: input.linkedProject?.trim() || null,
          reopenCount: nextReopenCount,
          updatedBy,
        },
        select: { id: true },
      } as const;
      try {
        await db.defect.update(updateArgs);
        await prisma.defectOpLog.create({
          data: {
            defectId: id,
            action: "DEFECT_UPDATE",
            detail: updateDetail,
          },
          select: { id: true },
        });
      } catch (e) {
        // 兼容：数据库/Prisma Client 仍是旧枚举值
        if (isInvalidEnumValueError(e, "status")) {
          await db.defect.update({
            ...updateArgs,
            data: { ...updateArgs.data, status: toLegacyStatus(input.status) },
          });
          await prisma.defectOpLog.create({
            data: {
              defectId: id,
              action: "DEFECT_UPDATE",
              detail: updateDetail,
            },
            select: { id: true },
          });
        } else {
          throw e;
        }
      }
      revalidatePath("/defects");
      return { ok: true, id };
    }

    const defectNo = (input.defectNo ?? "").trim() || genDefectNo();
    const createArgs = {
      data: {
        defectNo,
        name,
        status: input.status,
        severity: input.severity,
        iterationCode: input.iterationCode?.trim() || null,
        caseNo: input.caseNo?.trim() || null,
        devOwner: input.devOwner?.trim() || null,
        submitter: input.submitter?.trim() || null,
        foundAt,
        description: input.description?.trim() || null,
        linkedTestId: input.linkedTestId?.trim() || null,
        linkedProject: input.linkedProject?.trim() || null,
        reopenCount: 0,
        updatedBy,
      },
      select: { id: true },
    } as const;
    let created: { id: string };
    try {
      created = await db.defect.create(createArgs);
    } catch (e) {
      if (isInvalidEnumValueError(e, "status")) {
        created = await db.defect.create({
          ...createArgs,
          data: { ...createArgs.data, status: toLegacyStatus(input.status) },
        });
      } else {
        throw e;
      }
    }
    const createDetail = await buildDefectCreateDetail({
      defectNo,
      name,
      status: input.status,
      severity: input.severity,
      iterationCode: input.iterationCode?.trim() || null,
      caseNo: input.caseNo?.trim() || null,
      devOwner: input.devOwner?.trim() || null,
      submitter: input.submitter?.trim() || null,
      foundAt,
      description: input.description?.trim() || null,
      linkedTestId: input.linkedTestId?.trim() || null,
      linkedProject: input.linkedProject?.trim() || null,
      reopenCount: 0,
      updatedBy,
    });
    await prisma.defectOpLog.create({
      data: {
        defectId: created.id,
        action: "DEFECT_CREATE",
        detail: createDetail,
      },
      select: { id: true },
    });
    revalidatePath("/defects");
    return { ok: true, id: created.id };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function deleteDefect(id: string): Promise<ActionResult> {
  const i = id.trim();
  if (!i) return { error: "无效缺陷" };
  try {
    await prisma.$transaction(async (tx) => {
      const db = tx as unknown as {
        defect: {
          findUnique: (args: unknown) => Promise<unknown>;
          delete: (args: unknown) => Promise<{ id: string }>;
        };
        defectDeleted: { createMany: (args: unknown) => Promise<unknown> };
      };
      const row = (await db.defect.findUnique({
        where: { id: i },
        include: { linkedCases: { select: { testCaseId: true } } },
      })) as unknown as
        | (Record<string, unknown> & { linkedCases?: Array<{ testCaseId: string }> })
        | null;
      if (!row) return;
      const deletedAt = new Date();
      await db.defectDeleted.createMany({
        data: [
          {
            originalId: String(row.id),
            defectNo: String(row.defectNo),
            name: String(row.name),
            status: row.status,
            severity: row.severity,
            iterationCode: row.iterationCode ?? null,
            caseNo: row.caseNo ?? null,
            devOwner: row.devOwner ?? null,
            submitter: row.submitter ?? null,
            foundAt: row.foundAt ?? null,
            description: row.description ?? null,
            linkedTestId: row.linkedTestId ?? null,
            linkedProject: row.linkedProject ?? null,
            reopenCount: Number(row.reopenCount ?? 0),
            updatedBy: row.updatedBy ?? null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt,
            linkedTestCaseIds: (row.linkedCases ?? []).map((x) => x.testCaseId),
          },
        ],
      });
      await db.defect.delete({ where: { id: i }, select: { id: true } });
    });
    revalidatePath("/defects");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function bulkDeleteDefects(ids: string[]): Promise<ActionResult> {
  const uniq = Array.from(new Set(ids.map((x) => x.trim()).filter(Boolean)));
  if (uniq.length === 0) return { error: "请选择要删除的缺陷" };
  try {
    await prisma.$transaction(async (tx) => {
      const db = tx as unknown as {
        defect: {
          findMany: (args: unknown) => Promise<unknown[]>;
          deleteMany: (args: unknown) => Promise<unknown>;
        };
        defectDeleted: { createMany: (args: unknown) => Promise<unknown> };
      };
      const rows = (await db.defect.findMany({
        where: { id: { in: uniq } },
        include: { linkedCases: { select: { testCaseId: true } } },
      })) as unknown as Array<
        Record<string, unknown> & { linkedCases?: Array<{ testCaseId: string }> }
      >;
      const deletedAt = new Date();
      await db.defectDeleted.createMany({
        data: rows.map((row) => ({
          originalId: String(row.id),
          defectNo: String(row.defectNo),
          name: String(row.name),
          status: row.status,
          severity: row.severity,
          iterationCode: row.iterationCode ?? null,
          caseNo: row.caseNo ?? null,
          devOwner: row.devOwner ?? null,
          submitter: row.submitter ?? null,
          foundAt: row.foundAt ?? null,
          description: row.description ?? null,
          linkedTestId: row.linkedTestId ?? null,
          linkedProject: row.linkedProject ?? null,
          reopenCount: Number(row.reopenCount ?? 0),
          updatedBy: row.updatedBy ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          deletedAt,
          linkedTestCaseIds: (row.linkedCases ?? []).map((x) => x.testCaseId),
        })),
      });
      await db.defect.deleteMany({ where: { id: { in: uniq } } });
    });
    revalidatePath("/defects");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

