"use server";

import { Prisma, type RequirementStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  formatRequirementPriorityExport,
  parseRequirementPriorityImport,
  requirementPriorityLabel,
} from "@/lib/requirement-priority";
import { deriveRequirementStatusFromTaskProgress } from "@/lib/requirement-progress-status";
import { formatIsoBeijing } from "@/lib/timezone-cn";
import {
  nextWbsForNewSiblingUnderParent,
  parentWbsFromChildWbs,
} from "@/lib/wbs-id";
import { archiveTestDesignsBeforeRequirementDelete } from "@/app/actions/test-design";

export type ActionResult = { ok?: true; error?: string };

/** 数据库表结构未与 prisma/schema 同步时的统一提示（避免向用户暴露引擎/路径细节） */
const PRISMA_DB_SCHEMA_MISMATCH_MESSAGE =
  "数据库结构与当前程序不一致（例如缺少新字段）。请在项目根目录执行 npx prisma db push 同步表结构；若曾修改 schema，请在停止开发服务后执行 npx prisma generate，删除 .next 文件夹并重新启动开发服务。";

function prismaKnownToMessage(e: Prisma.PrismaClientKnownRequestError): string {
  switch (e.code) {
    case "P2002":
      return "与已有数据冲突（例如同一迭代下 WBS 编号重复、data_id 重复等）。";
    case "P2022":
      return PRISMA_DB_SCHEMA_MISMATCH_MESSAGE;
    case "P2025":
      return "记录不存在或已被删除。";
    case "P2003":
      return "存在关联数据，当前操作无法完成。";
    default:
      return `数据操作未成功（${e.code}），请稍后重试或联系管理员。`;
  }
}

function messageLooksLikeDbMissingColumn(msg: string): boolean {
  return (
    msg.includes("does not exist in the current database") ||
    msg.includes("No such column") ||
    msg.includes("no such column")
  );
}

function toUserActionError(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return prismaKnownToMessage(e);
  }
  const argMsg = messageForPrismaArgumentValueFailure(e);
  if (argMsg) return argMsg;
  if (e instanceof Error && e.message) {
    if (messageLooksLikeDbMissingColumn(e.message)) {
      return PRISMA_DB_SCHEMA_MISMATCH_MESSAGE;
    }
    if (
      e.message.startsWith("操作失败：") ||
      e.message.includes("无效或无法写入") ||
      e.message.includes("无效或超出可存储范围") ||
      /^第 \d+ 行/.test(e.message)
    ) {
      return e.message;
    }
    return `操作失败：${e.message}`;
  }
  return "操作失败，请稍后重试。";
}

function isUnknownField(e: unknown, field: string): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes(`Unknown field \`${field}\``);
}

/** Prisma Client 未识别字段，或库中真实缺列（SQLite 等与 Unknown field 文案不同） */
function shouldDegradePlanDateFields(e: unknown): boolean {
  if (isUnknownField(e, "planStartAt") || isUnknownField(e, "planEndAt")) {
    return true;
  }
  if (!(e instanceof Error)) return false;
  const msg = e.message;
  if (!msg.includes("planStartAt") && !msg.includes("planEndAt")) return false;
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2022") {
    return true;
  }
  return messageLooksLikeDbMissingColumn(msg);
}

const REQUIREMENT_STATUS_LOG: Record<RequirementStatus, string> = {
  UNASSIGNED: "未分配",
  IN_DEVELOPMENT: "开发中",
  PENDING_VERIFICATION: "待验证",
  CLOSED: "已上线",
};

function normStrLog(s: string | null | undefined): string {
  return (s ?? "").trim();
}

function normDescLog(s: string | null | undefined): string {
  return normStrLog(s);
}

function truncateForLog(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

const PLAN_DATE_YEAR_MIN = 1900;
const PLAN_DATE_YEAR_MAX = 2100;

/** 与 SQLite/Prisma 兼容的计划时间范围，避免 JS 接受但引擎无法序列化的年份 */
function dateIsPersistableAsPlan(d: Date): boolean {
  if (Number.isNaN(d.getTime())) return false;
  const y = d.getUTCFullYear();
  return y >= PLAN_DATE_YEAR_MIN && y <= PLAN_DATE_YEAR_MAX;
}

function tryParsePlanDateFromImportCell(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && n >= 1 && n < 6_000_000) {
      const epoch = Date.UTC(1899, 11, 30);
      const ms = epoch + Math.round(n * 86_400_000);
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime()) && dateIsPersistableAsPlan(d)) return d;
    }
    return null;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (!dateIsPersistableAsPlan(d)) return null;
  return d;
}

type ImportPlanParseResult =
  | { ok: true; date: Date | null }
  | { ok: false; message: string };

function parseImportPlanDateCell(
  raw: string,
  columnLabel: string,
): ImportPlanParseResult {
  const s = raw.trim();
  if (!s) return { ok: true, date: null };
  const d = tryParsePlanDateFromImportCell(s);
  if (d === null) {
    const hint = s.length > 40 ? `${s.slice(0, 40)}…` : s;
    return {
      ok: false,
      message: `${columnLabel}无效或无法写入：请使用合法日期时间（年份宜在 ${PLAN_DATE_YEAR_MIN}–${PLAN_DATE_YEAR_MAX}），或留空。当前格内容：「${hint}」`,
    };
  }
  return { ok: true, date: d };
}

function planIsoInputErrorIfInvalid(
  raw: string | null | undefined,
  parsed: Date | null,
  label: string,
): string | null {
  if (raw === null || raw === undefined) return null;
  if (String(raw).trim() === "") return null;
  if (parsed === null) {
    return `${label}无效或超出可存储范围（请将年份控制在约 ${PLAN_DATE_YEAR_MIN}–${PLAN_DATE_YEAR_MAX} 年之间）。`;
  }
  return null;
}

function parseOptionalPlanDateIso(iso: string | null | undefined): Date | null {
  if (iso === null || iso === undefined) return null;
  const s = String(iso).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  if (!dateIsPersistableAsPlan(d)) return null;
  return d;
}

/** Prisma 无法序列化日期等参数时的友好说明（不暴露引擎内部结构） */
function messageForPrismaArgumentValueFailure(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (
    msg.includes("Could not convert argument value") ||
    msg.includes("ArgumentValue") ||
    (msg.includes("DateTime") && msg.includes("$type"))
  ) {
    return `日期时间字段无法写入数据库。请检查「计划开始时间」「计划结束时间」是否为合法日期（年份宜在 ${PLAN_DATE_YEAR_MIN}–${PLAN_DATE_YEAR_MAX} 年）；导入时请确认 Excel 日期列未被当成普通文本或错误公式。`;
  }
  return null;
}

function planDateForLog(d: Date | null | undefined): string {
  if (!d) return "空";
  return formatIsoBeijing(d.toISOString());
}

export type IterationOption = { id: string; label: string; productId: string };

export async function listIterationOptions(
  productId?: string | null,
): Promise<IterationOption[]> {
  const pid = (productId ?? "").trim();
  const rows = await prisma.iteration.findMany({
    where: pid ? { productId: pid } : undefined,
    include: { product: true },
    orderBy: [{ updatedAt: "desc" }],
  });
  return rows.map((it) => ({
    id: it.id,
    label: `${it.product.name} / ${it.name}`,
    productId: it.productId,
  }));
}

export type RequirementFlat = {
  id: string;
  title: string;
  wbsId: string | null;
  parentId: string | null;
  iterationId: string;
  sortOrder: number;
  taskProgress: string | null;
  latestProgress: string | null;
  priority: number | null;
  status: RequirementStatus;
  submitter: string | null;
  devOwner: string | null;
  testOwner: string | null;
  planStartAt: string | null;
  planEndAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function listRequirementsFlat(
  iterationId: string,
): Promise<RequirementFlat[]> {
  const id = iterationId.trim();
  if (!id) return [];
  try {
    const rows = await prisma.requirement.findMany({
      where: { iterationId: id },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        wbsId: true,
        parentId: true,
        iterationId: true,
        sortOrder: true,
        taskProgress: true,
        latestProgress: true,
        priority: true,
        status: true,
        submitter: true,
        devOwner: true,
        testOwner: true,
        planStartAt: true,
        planEndAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((r) => ({
      ...r,
      planStartAt: r.planStartAt?.toISOString() ?? null,
      planEndAt: r.planEndAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  } catch (e) {
    if (isUnknownField(e, "wbsId")) {
      const rows = await prisma.requirement.findMany({
        where: { iterationId: id },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          parentId: true,
          iterationId: true,
          sortOrder: true,
          taskProgress: true,
          latestProgress: true,
          priority: true,
          status: true,
          submitter: true,
          devOwner: true,
          testOwner: true,
          planStartAt: true,
          planEndAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return rows.map((r) => ({
        ...r,
        wbsId: null,
        planStartAt: r.planStartAt?.toISOString() ?? null,
        planEndAt: r.planEndAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    }
    // 兼容：若 Prisma Client 尚未 generate，可能不认识新字段 devOwner/testOwner
    if (isUnknownField(e, "devOwner") || isUnknownField(e, "testOwner")) {
      const rows = await prisma.requirement.findMany({
        where: { iterationId: id },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          parentId: true,
          iterationId: true,
          sortOrder: true,
          taskProgress: true,
          latestProgress: true,
          priority: true,
          status: true,
          submitter: true,
          planStartAt: true,
          planEndAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return rows.map((r) => ({
        ...r,
        wbsId: null,
        devOwner: null,
        testOwner: null,
        planStartAt: r.planStartAt?.toISOString() ?? null,
        planEndAt: r.planEndAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    }
    if (isUnknownField(e, "taskProgress") || isUnknownField(e, "latestProgress")) {
      const rows = await prisma.requirement.findMany({
        where: { iterationId: id },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          parentId: true,
          iterationId: true,
          sortOrder: true,
          priority: true,
          status: true,
          submitter: true,
          devOwner: true,
          testOwner: true,
          planStartAt: true,
          planEndAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return rows.map((r) => ({
        ...r,
        wbsId: null,
        taskProgress: null,
        latestProgress: null,
        planStartAt: r.planStartAt?.toISOString() ?? null,
        planEndAt: r.planEndAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    }
    if (shouldDegradePlanDateFields(e)) {
      const rows = await prisma.requirement.findMany({
        where: { iterationId: id },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          parentId: true,
          iterationId: true,
          sortOrder: true,
          taskProgress: true,
          latestProgress: true,
          priority: true,
          status: true,
          submitter: true,
          devOwner: true,
          testOwner: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return rows.map((r) => ({
        ...r,
        wbsId: null,
        planStartAt: null,
        planEndAt: null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    }
    throw new Error(toUserActionError(e));
  }
}

export async function createRequirementNode(input: {
  iterationId: string;
  parentId: string | null;
  title: string;
  priority: number | null;
  status?: RequirementStatus;
  submitter?: string | null;
  devOwner?: string | null;
  testOwner?: string | null;
  description?: string | null;
  planStartAt?: string | null;
  planEndAt?: string | null;
}): Promise<ActionResult> {
  const title = input.title.trim();
  if (!input.iterationId) return { error: "请选择迭代" };
  if (!title) return { error: "任务名称不能为空" };
  const description =
    input.description === null || input.description === undefined
      ? null
      : input.description.trim() || null;
  const nextPlanStart = parseOptionalPlanDateIso(input.planStartAt ?? null);
  const nextPlanEnd = parseOptionalPlanDateIso(input.planEndAt ?? null);
  const errPlanStart = planIsoInputErrorIfInvalid(
    input.planStartAt,
    nextPlanStart,
    "计划开始时间",
  );
  if (errPlanStart) return { error: errPlanStart };
  const errPlanEnd = planIsoInputErrorIfInvalid(
    input.planEndAt,
    nextPlanEnd,
    "计划结束时间",
  );
  if (errPlanEnd) return { error: errPlanEnd };
  try {
    const maxSort = await prisma.requirement.aggregate({
      where: { iterationId: input.iterationId, parentId: input.parentId },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxSort._max.sortOrder ?? 0) + 1;
    try {
      await prisma.requirement.create({
        data: {
          iterationId: input.iterationId,
          parentId: input.parentId,
          title,
          description,
          priority: input.priority,
          status: input.status ?? "UNASSIGNED",
          submitter: input.submitter ?? null,
          devOwner: input.devOwner ?? null,
          testOwner: input.testOwner ?? null,
          planStartAt: nextPlanStart,
          planEndAt: nextPlanEnd,
          sortOrder,
        },
        select: { id: true },
      });
    } catch (e) {
      if (isUnknownField(e, "devOwner") || isUnknownField(e, "testOwner")) {
        try {
          await prisma.requirement.create({
            data: {
              iterationId: input.iterationId,
              parentId: input.parentId,
              title,
              description,
              priority: input.priority,
              status: input.status ?? "UNASSIGNED",
              submitter: input.submitter ?? null,
              planStartAt: nextPlanStart,
              planEndAt: nextPlanEnd,
              sortOrder,
            },
            select: { id: true },
          });
        } catch (e2) {
          if (
            isUnknownField(e2, "planStartAt") ||
            isUnknownField(e2, "planEndAt")
          ) {
            await prisma.requirement.create({
              data: {
                iterationId: input.iterationId,
                parentId: input.parentId,
                title,
                description,
                priority: input.priority,
                status: input.status ?? "UNASSIGNED",
                submitter: input.submitter ?? null,
                sortOrder,
              },
              select: { id: true },
            });
          } else {
            throw e2;
          }
        }
      } else if (
        isUnknownField(e, "planStartAt") ||
        isUnknownField(e, "planEndAt")
      ) {
        try {
          await prisma.requirement.create({
            data: {
              iterationId: input.iterationId,
              parentId: input.parentId,
              title,
              description,
              priority: input.priority,
              status: input.status ?? "UNASSIGNED",
              submitter: input.submitter ?? null,
              devOwner: input.devOwner ?? null,
              testOwner: input.testOwner ?? null,
              sortOrder,
            },
            select: { id: true },
          });
        } catch (e2) {
          if (isUnknownField(e2, "devOwner") || isUnknownField(e2, "testOwner")) {
            await prisma.requirement.create({
              data: {
                iterationId: input.iterationId,
                parentId: input.parentId,
                title,
                description,
                priority: input.priority,
                status: input.status ?? "UNASSIGNED",
                submitter: input.submitter ?? null,
                sortOrder,
              },
              select: { id: true },
            });
          } else {
            throw e2;
          }
        }
      } else {
        throw e;
      }
    }
    revalidatePath("/requirements");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function renameRequirementNode(
  id: string,
  title: string,
): Promise<ActionResult> {
  const t = title.trim();
  if (!t) return { error: "任务名称不能为空" };
  try {
    await prisma.requirement.update({
      where: { id },
      data: { title: t },
      select: { id: true },
    });
    revalidatePath("/requirements");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

async function collectRequirementSubtreeIds(
  rootId: string,
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const root = await tx.requirement.findUnique({
    where: { id: rootId },
    select: { iterationId: true },
  });
  if (!root) return [];
  const all = await tx.requirement.findMany({
    where: { iterationId: root.iterationId },
    select: { id: true, parentId: true },
  });
  const children = new Map<string, string[]>();
  for (const r of all) {
    if (!r.parentId) continue;
    const arr = children.get(r.parentId) ?? [];
    arr.push(r.id);
    children.set(r.parentId, arr);
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    out.push(cur);
    for (const cid of children.get(cur) ?? []) stack.push(cid);
  }
  return out;
}

export async function deleteRequirementNode(id: string): Promise<ActionResult> {
  const i = id.trim();
  if (!i) return { error: "无效节点" };
  try {
    await prisma.$transaction(async (tx) => {
      const reqSubtree = await collectRequirementSubtreeIds(i, tx);
      await archiveTestDesignsBeforeRequirementDelete(tx, reqSubtree);
      await tx.requirement.delete({ where: { id: i }, select: { id: true } });
    });
    revalidatePath("/requirements");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function getRequirementNodeDetail(id: string) {
  return prisma.requirement.findUnique({
    where: { id },
    include: {
      iteration: { include: { product: true } },
      attachments: { orderBy: { createdAt: "desc" } },
    },
  });
}

export type RequirementOpLogRow = {
  id: string;
  action: string;
  detail: string | null;
  createdAt: string;
};

export async function getRequirementOpLogs(
  requirementId: string,
  take = 50,
): Promise<RequirementOpLogRow[]> {
  const rid = requirementId.trim();
  if (!rid) return [];
  try {
    const rows = await prisma.requirementOpLog.findMany({
      where: { requirementId: rid },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, action: true, detail: true, createdAt: true },
    });
    return rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch {
    return [];
  }
}

async function appendRequirementOpLog(
  requirementId: string,
  action: string,
  detail?: string | null,
) {
  try {
    await prisma.requirementOpLog.create({
      data: {
        requirementId,
        action,
        detail: detail === undefined ? null : detail,
      },
    });
  } catch {
    /* 忽略日志写入失败，不阻断主操作 */
  }
}

export async function updateRequirementNodeDetail(input: {
  id: string;
  title: string;
  description: string | null;
  taskProgress: string | null;
  latestProgress: string | null;
  priority: number | null;
  status: RequirementStatus;
  submitter: string | null;
  devOwner: string | null;
  testOwner: string | null;
  planStartAt: string | null;
  planEndAt: string | null;
  wbsId: string | null;
}): Promise<ActionResult> {
  const title = input.title.trim();
  if (!title) return { error: "任务名称不能为空" };
  const nextWbsId =
    input.wbsId === null || input.wbsId === undefined
      ? null
      : input.wbsId.trim() || null;
  const nextPlanStart = parseOptionalPlanDateIso(input.planStartAt);
  const nextPlanEnd = parseOptionalPlanDateIso(input.planEndAt);
  const errPlanStart = planIsoInputErrorIfInvalid(
    input.planStartAt,
    nextPlanStart,
    "计划开始时间",
  );
  if (errPlanStart) return { error: errPlanStart };
  const errPlanEnd = planIsoInputErrorIfInvalid(
    input.planEndAt,
    nextPlanEnd,
    "计划结束时间",
  );
  if (errPlanEnd) return { error: errPlanEnd };
  const derivedFromProgress = deriveRequirementStatusFromTaskProgress(
    input.taskProgress,
  );
  const effectiveStatus: RequirementStatus =
    derivedFromProgress ?? input.status;
  try {
    const before = await prisma.requirement.findUnique({
      where: { id: input.id },
      select: {
        title: true,
        description: true,
        taskProgress: true,
        latestProgress: true,
        priority: true,
        status: true,
        submitter: true,
        devOwner: true,
        testOwner: true,
        planStartAt: true,
        planEndAt: true,
        wbsId: true,
      },
    });
    if (!before) return { error: "记录不存在或已被删除。" };

    let usedDevFields = true;
    try {
      await prisma.requirement.update({
        where: { id: input.id },
        data: {
          title,
          description: input.description,
          taskProgress: input.taskProgress,
          latestProgress: input.latestProgress,
          priority: input.priority,
          status: effectiveStatus,
          submitter: input.submitter,
          devOwner: input.devOwner,
          testOwner: input.testOwner,
          planStartAt: nextPlanStart,
          planEndAt: nextPlanEnd,
          wbsId: nextWbsId,
        },
        select: { id: true },
      });
    } catch (e) {
      if (isUnknownField(e, "devOwner") || isUnknownField(e, "testOwner")) {
        usedDevFields = false;
        try {
          await prisma.requirement.update({
            where: { id: input.id },
            data: {
              title,
              description: input.description,
              taskProgress: input.taskProgress,
              latestProgress: input.latestProgress,
              priority: input.priority,
              status: effectiveStatus,
              submitter: input.submitter,
              planStartAt: nextPlanStart,
              planEndAt: nextPlanEnd,
              wbsId: nextWbsId,
            },
            select: { id: true },
          });
        } catch (e2) {
          if (
            isUnknownField(e2, "taskProgress") ||
            isUnknownField(e2, "latestProgress")
          ) {
            await prisma.requirement.update({
              where: { id: input.id },
              data: {
                title,
                description: input.description,
                priority: input.priority,
                status: effectiveStatus,
                submitter: input.submitter,
                planStartAt: nextPlanStart,
                planEndAt: nextPlanEnd,
                wbsId: nextWbsId,
              },
              select: { id: true },
            });
          } else {
            throw e2;
          }
        }
      } else if (
        isUnknownField(e, "taskProgress") ||
        isUnknownField(e, "latestProgress")
      ) {
        await prisma.requirement.update({
          where: { id: input.id },
          data: {
            title,
            description: input.description,
            priority: input.priority,
            status: effectiveStatus,
            submitter: input.submitter,
            devOwner: input.devOwner,
            testOwner: input.testOwner,
            planStartAt: nextPlanStart,
            planEndAt: nextPlanEnd,
            wbsId: nextWbsId,
          },
          select: { id: true },
        });
      } else if (isUnknownField(e, "wbsId")) {
        await prisma.requirement.update({
          where: { id: input.id },
          data: {
            title,
            description: input.description,
            taskProgress: input.taskProgress,
            latestProgress: input.latestProgress,
            priority: input.priority,
            status: effectiveStatus,
            submitter: input.submitter,
            devOwner: input.devOwner,
            testOwner: input.testOwner,
            planStartAt: nextPlanStart,
            planEndAt: nextPlanEnd,
          },
          select: { id: true },
        });
      } else {
        throw e;
      }
    }
    revalidatePath("/requirements");
    revalidatePath(`/requirements/node/${input.id}`);

    const changes: string[] = [];
    if (before.title !== title) {
      changes.push(
        `任务名称：「${truncateForLog(before.title, 60)}」→「${truncateForLog(title, 60)}」`,
      );
    }
    const d0 = normDescLog(before.description);
    const d1 = normDescLog(input.description);
    if (d0 !== d1) {
      changes.push(
        `描述：「${truncateForLog(d0, 80)}」→「${truncateForLog(d1, 80)}」`,
      );
    }
    const tp0 = normDescLog(before.taskProgress);
    const tp1 = normDescLog(input.taskProgress);
    if (tp0 !== tp1) {
      changes.push(
        `任务进度：「${truncateForLog(tp0, 80)}」→「${truncateForLog(tp1, 80)}」`,
      );
    }
    const lp0 = normDescLog(before.latestProgress);
    const lp1 = normDescLog(input.latestProgress);
    if (lp0 !== lp1) {
      changes.push(
        `最新进展情况：「${truncateForLog(lp0, 80)}」→「${truncateForLog(lp1, 80)}」`,
      );
    }
    if (before.priority !== input.priority) {
      changes.push(
        `优先级：${requirementPriorityLabel(before.priority)} → ${requirementPriorityLabel(input.priority)}`,
      );
    }
    if (before.status !== effectiveStatus) {
      changes.push(
        `状态：${REQUIREMENT_STATUS_LOG[before.status]} → ${REQUIREMENT_STATUS_LOG[effectiveStatus]}${derivedFromProgress !== null ? "（随任务进度自动校验）" : ""}`,
      );
    }
    const s0 = normStrLog(before.submitter);
    const s1 = normStrLog(input.submitter);
    if (s0 !== s1) {
      changes.push(`提交人：${s0 || "空"} → ${s1 || "空"}`);
    }
    if (usedDevFields) {
      const v0 = normStrLog(before.devOwner);
      const v1 = normStrLog(input.devOwner);
      if (v0 !== v1) {
        changes.push(`开发负责人：${v0 || "空"} → ${v1 || "空"}`);
      }
      const w0 = normStrLog(before.testOwner);
      const w1 = normStrLog(input.testOwner);
      if (w0 !== w1) {
        changes.push(`测试负责人：${w0 || "空"} → ${w1 || "空"}`);
      }
    }
    const bps = before.planStartAt?.getTime() ?? null;
    const aps = nextPlanStart?.getTime() ?? null;
    if (bps !== aps) {
      changes.push(
        `计划开始：${planDateForLog(before.planStartAt)} → ${planDateForLog(nextPlanStart)}`,
      );
    }
    const bpe = before.planEndAt?.getTime() ?? null;
    const ape = nextPlanEnd?.getTime() ?? null;
    if (bpe !== ape) {
      changes.push(
        `计划结束：${planDateForLog(before.planEndAt)} → ${planDateForLog(nextPlanEnd)}`,
      );
    }
    const wb0 = normStrLog(before.wbsId);
    const wb1 = normStrLog(nextWbsId);
    if (wb0 !== wb1) {
      changes.push(`WBS编号：${wb0 || "空"} → ${wb1 || "空"}`);
    }

    await appendRequirementOpLog(
      input.id,
      "更新需求详情",
      changes.length > 0
        ? changes.join("；")
        : "（字段与保存前一致，无变更内容）",
    );
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

/** 列表行内快速修改（优先级、状态、任务进度、最新进展） */
export async function patchRequirementRowFields(input: {
  id: string;
  priority?: number | null;
  status?: RequirementStatus;
  taskProgress?: string | null;
  latestProgress?: string | null;
}): Promise<ActionResult> {
  const id = input.id.trim();
  if (!id) return { error: "无效节点" };
  const hasPatch =
    input.priority !== undefined ||
    input.status !== undefined ||
    input.taskProgress !== undefined ||
    input.latestProgress !== undefined;
  if (!hasPatch) return { ok: true };

  try {
    const before = await prisma.requirement.findUnique({
      where: { id },
      select: {
        priority: true,
        status: true,
        taskProgress: true,
        latestProgress: true,
      },
    });
    if (!before) return { error: "记录不存在或已被删除。" };

    const data: Prisma.RequirementUpdateInput = {};
    const changes: string[] = [];

    if (input.priority !== undefined) {
      data.priority = input.priority;
      if (before.priority !== input.priority) {
        changes.push(
          `优先级：${requirementPriorityLabel(before.priority)} → ${requirementPriorityLabel(input.priority)}`,
        );
      }
    }
    if (input.taskProgress !== undefined) {
      data.taskProgress = input.taskProgress;
      const t0 = normDescLog(before.taskProgress);
      const t1 = normDescLog(input.taskProgress);
      if (t0 !== t1) {
        changes.push(
          `任务进度：「${truncateForLog(t0, 40)}」→「${truncateForLog(t1, 40)}」`,
        );
      }
    }
    const derivedFromProgress =
      input.taskProgress !== undefined
        ? deriveRequirementStatusFromTaskProgress(input.taskProgress)
        : null;
    let nextStatus: RequirementStatus | undefined;
    if (derivedFromProgress !== null) {
      nextStatus = derivedFromProgress;
    } else if (input.status !== undefined) {
      nextStatus = input.status;
    }
    if (nextStatus !== undefined) {
      data.status = nextStatus;
      if (before.status !== nextStatus) {
        changes.push(
          `状态：${REQUIREMENT_STATUS_LOG[before.status]} → ${REQUIREMENT_STATUS_LOG[nextStatus]}${derivedFromProgress !== null ? "（随任务进度自动校验）" : ""}`,
        );
      }
    }
    if (input.latestProgress !== undefined) {
      data.latestProgress = input.latestProgress;
      const t0 = normDescLog(before.latestProgress);
      const t1 = normDescLog(input.latestProgress);
      if (t0 !== t1) {
        changes.push(
          `最新进展：「${truncateForLog(t0, 40)}」→「${truncateForLog(t1, 40)}」`,
        );
      }
    }

    if (Object.keys(data).length === 0) return { ok: true };

    await prisma.requirement.update({
      where: { id },
      data,
      select: { id: true },
    });
    revalidatePath("/requirements");
    revalidatePath(`/requirements/node/${id}`);

    if (changes.length > 0) {
      await appendRequirementOpLog(
        id,
        "更新需求（列表）",
        changes.join("；"),
      );
    }
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

/** 与前端单文件 10MB 上限对应；Data URL 约为原文件的 ~4/3 */
const MAX_ATTACHMENT_DATA_URL_CHARS = 15 * 1024 * 1024;

export async function addRequirementAttachment(input: {
  requirementId: string;
  name: string;
  url: string;
}): Promise<
  { ok: true; id: string; createdAt: string } | { error: string }
> {
  const rid = input.requirementId.trim();
  const name = input.name.trim();
  const url = input.url.trim();
  if (!rid) return { error: "缺少需求 id。" };
  if (!name) return { error: "附件名称无效。" };
  if (!url) return { error: "附件内容为空。" };
  if (url.length > MAX_ATTACHMENT_DATA_URL_CHARS) {
    return { error: "附件过大。请选择不超过 10MB 的文件。" };
  }
  try {
    const row = await prisma.requirementAttachment.create({
      data: { requirementId: rid, name, url },
      select: { id: true, createdAt: true },
    });
    revalidatePath(`/requirements/node/${rid}`);
    revalidatePath("/requirements");
    await appendRequirementOpLog(rid, "添加附件", name);
    return {
      ok: true,
      id: row.id,
      createdAt: row.createdAt.toISOString(),
    };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function deleteRequirementAttachment(id: string): Promise<ActionResult> {
  const i = id.trim();
  if (!i) return { error: "无效附件" };
  try {
    const att = await prisma.requirementAttachment.findUnique({
      where: { id: i },
      select: { requirementId: true, name: true },
    });
    if (!att) return { error: "附件不存在或已删除。" };
    await prisma.requirementAttachment.delete({ where: { id: i }, select: { id: true } });
    revalidatePath(`/requirements/node/${att.requirementId}`);
    revalidatePath("/requirements");
    await appendRequirementOpLog(att.requirementId, "删除附件", att.name);
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export type RequirementExportRow = {
  节点ID: string;
  父节点ID: string;
  data_id: string;
  wbs_id: string;
  任务名称: string;
  优先级: string;
  状态: string;
  任务进度: string;
  最新进展情况: string;
  提交人: string;
  开发负责人: string;
  测试负责人: string;
  计划开始时间: string;
  计划结束时间: string;
  创建时间: string;
  更新时间: string;
};

function mapRequirementToExportRow(r: {
  id: string;
  parentId: string | null;
  dataId: string | null;
  wbsId: string | null;
  title: string;
  taskProgress: string | null;
  latestProgress: string | null;
  priority: number | null;
  status: RequirementStatus;
  submitter: string | null;
  devOwner: string | null;
  testOwner: string | null;
  planStartAt: Date | null;
  planEndAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): RequirementExportRow {
  return {
    节点ID: r.id,
    父节点ID: r.parentId ?? "",
    data_id: r.dataId ?? "",
    wbs_id: r.wbsId ?? "",
    任务名称: r.title,
    优先级: formatRequirementPriorityExport(r.priority),
    状态: String(r.status),
    任务进度: r.taskProgress ?? "",
    最新进展情况: r.latestProgress ?? "",
    提交人: r.submitter ?? "",
    开发负责人: r.devOwner ?? "",
    测试负责人: r.testOwner ?? "",
    计划开始时间: r.planStartAt ? r.planStartAt.toISOString() : "",
    计划结束时间: r.planEndAt ? r.planEndAt.toISOString() : "",
    创建时间: r.createdAt.toISOString(),
    更新时间: r.updatedAt.toISOString(),
  };
}

export async function getRequirementsExportRows(
  ids: string[],
): Promise<{ rows?: RequirementExportRow[]; error?: string }> {
  try {
    const uniq = Array.from(new Set(ids.map((x) => x.trim()).filter(Boolean)));
    if (uniq.length === 0) return { rows: [] };
    const rows = await prisma.requirement.findMany({
      where: { id: { in: uniq } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        parentId: true,
        dataId: true,
        wbsId: true,
        title: true,
        taskProgress: true,
        latestProgress: true,
        priority: true,
        status: true,
        submitter: true,
        devOwner: true,
        testOwner: true,
        planStartAt: true,
        planEndAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return {
      rows: rows.map(mapRequirementToExportRow),
    };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

/** 导出当前迭代下全部需求（树关系通过 父节点ID 保留，便于再导入） */
export async function getRequirementsExportAllForIteration(
  iterationId: string,
): Promise<{ rows?: RequirementExportRow[]; error?: string }> {
  const iter = iterationId.trim();
  if (!iter) return { rows: [] };
  try {
    const rows = await prisma.requirement.findMany({
      where: { iterationId: iter },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        parentId: true,
        dataId: true,
        wbsId: true,
        title: true,
        taskProgress: true,
        latestProgress: true,
        priority: true,
        status: true,
        submitter: true,
        devOwner: true,
        testOwner: true,
        planStartAt: true,
        planEndAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { rows: rows.map(mapRequirementToExportRow) };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export type ImportRequirementRow = {
  节点ID: string;
  父节点ID: string;
  /** 外部稳定 ID；与库中已有记录相同时更新该记录，否则新建（可留空） */
  data_id: string;
  /** WBS 层级编号（如 1、1.1）；同一迭代内唯一；可仅填此项由程序推断父节点 */
  wbs_id: string;
  任务名称: string;
  优先级: string;
  状态: string;
  任务进度: string;
  最新进展情况: string;
  提交人: string;
  开发负责人: string;
  测试负责人: string;
  计划开始时间: string;
  计划结束时间: string;
};

const STATUS_ZH_TO_ENUM: Record<string, RequirementStatus> = {
  未分配: "UNASSIGNED",
  开发中: "IN_DEVELOPMENT",
  待验证: "PENDING_VERIFICATION",
  已上线: "CLOSED",
};

function parseRequirementStatusImport(raw: string): RequirementStatus | null {
  const s = raw.trim();
  if (!s) return "UNASSIGNED";
  if (
    s === "UNASSIGNED" ||
    s === "IN_DEVELOPMENT" ||
    s === "PENDING_VERIFICATION" ||
    s === "CLOSED"
  ) {
    return s;
  }
  return STATUS_ZH_TO_ENUM[s] ?? null;
}

type NormalizedImport = {
  oldId: string;
  parentOldId: string | null;
  /** 非空时按全局唯一匹配已有需求并更新 */
  dataId: string | null;
  /** 同一迭代内唯一；用于导入时推断父子（1.1 的父为 1） */
  wbsId: string | null;
  title: string;
  taskProgress: string | null;
  latestProgress: string | null;
  priority: number | null;
  status: RequirementStatus;
  submitter: string | null;
  devOwner: string | null;
  testOwner: string | null;
  planStartAt: Date | null;
  planEndAt: Date | null;
  /** 导入文件中的原始行号（从 1 计），用于报错定位 */
  sourceRowIndex: number;
};

function importRowDepth(oldId: string, byId: Map<string, NormalizedImport>): number {
  let d = 0;
  let cur: string | null = oldId;
  const seen = new Set<string>();
  while (cur && byId.has(cur) && seen.size < byId.size + 2) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break;
    const parentRef = node.parentOldId;
    if (!parentRef || !byId.has(parentRef)) break;
    d++;
    cur = parentRef;
  }
  return d;
}

function importRowFailureMessage(item: NormalizedImport, e: unknown): string {
  const rowHint = `第 ${item.sourceRowIndex} 行（「${truncateForLog(item.title, 40)}」）`;
  return `${rowHint}：${toUserActionError(e)}`;
}

/**
 * 将导出格式 CSV/Excel 解析后的行导入到指定迭代。
 * - 若某行提供非空 `data_id` 且库中已存在相同值，则更新该需求（含归属迭代与父节点）；
 * - 否则新建节点；文件内 `节点ID` 仍用于同一文件内的父子关系映射；
 * - 若填写 `wbs_id`（如 1.1），且未指定「父节点ID」，则按 WBS 规则推断父行（1.1 的父为 1）。
 */
export async function importRequirementsCsv(
  iterationId: string,
  rows: ImportRequirementRow[],
): Promise<ActionResult & { imported?: number }> {
  const iter = iterationId.trim();
  if (!iter) return { error: "请选择迭代" };
  if (rows.length === 0) return { error: "没有可导入的行" };

  const it = await prisma.iteration.findUnique({
    where: { id: iter },
    select: { id: true },
  });
  if (!it) return { error: "迭代不存在" };

  const normalized: NormalizedImport[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const title = r.任务名称.trim();
    if (!title) continue;
    const status = parseRequirementStatusImport(r.状态);
    if (!status) {
      return { error: `第 ${i + 1} 行：无法识别状态「${r.状态}」` };
    }
    const priority = parseRequirementPriorityImport(r.优先级);
    const oldIdRaw = r.节点ID.trim();
    const oldId = oldIdRaw || `__import_${i}_${Math.random().toString(16).slice(2)}`;
    const dataIdTrim = r.data_id.trim();
    const dataId = dataIdTrim || null;
    const wbsIdTrim = r.wbs_id.trim();
    const wbsId = wbsIdTrim || null;
    const parentRaw = r.父节点ID.trim();
    const taskP = r.任务进度.trim();
    const latestP = r.最新进展情况.trim();
    const ps = parseImportPlanDateCell(r.计划开始时间, "计划开始时间");
    if (!ps.ok) {
      return { error: `第 ${i + 1} 行：${ps.message}` };
    }
    const pe = parseImportPlanDateCell(r.计划结束时间, "计划结束时间");
    if (!pe.ok) {
      return { error: `第 ${i + 1} 行：${pe.message}` };
    }
    const statusFromProgress = deriveRequirementStatusFromTaskProgress(
      taskP || null,
    );
    const statusFinal = statusFromProgress ?? status;
    normalized.push({
      oldId,
      parentOldId: parentRaw || null,
      dataId,
      wbsId,
      title,
      taskProgress: taskP || null,
      latestProgress: latestP || null,
      priority,
      status: statusFinal,
      submitter: r.提交人.trim() || null,
      devOwner: r.开发负责人.trim() || null,
      testOwner: r.测试负责人.trim() || null,
      planStartAt: ps.date,
      planEndAt: pe.date,
      sourceRowIndex: i + 1,
    });
  }

  if (normalized.length === 0) return { error: "没有有效的数据行（任务名称不能为空）" };

  const byId = new Map(normalized.map((x) => [x.oldId, x]));
  const idSet = new Set(byId.keys());

  const wbsToOldId = new Map<string, string>();
  for (const x of normalized) {
    if (!x.wbsId) continue;
    if (wbsToOldId.has(x.wbsId)) {
      return { error: `导入文件中 wbs_id「${x.wbsId}」出现多次` };
    }
    wbsToOldId.set(x.wbsId, x.oldId);
  }
  for (const x of normalized) {
    if (x.parentOldId) continue;
    const w = x.wbsId?.trim();
    if (!w) continue;
    const pw = parentWbsFromChildWbs(w);
    if (!pw) continue;
    const pOld = wbsToOldId.get(pw);
    if (pOld) x.parentOldId = pOld;
  }

  for (const x of normalized) {
    if (x.parentOldId && !idSet.has(x.parentOldId)) {
      x.parentOldId = null;
    }
  }

  const sorted = [...normalized].sort(
    (a, b) =>
      importRowDepth(a.oldId, byId) - importRowDepth(b.oldId, byId) ||
      a.title.localeCompare(b.title, "zh-CN"),
  );

  const seenFileDataIds = new Set<string>();
  for (const x of normalized) {
    if (!x.dataId) continue;
    if (seenFileDataIds.has(x.dataId)) {
      return { error: `导入文件中 data_id「${x.dataId}」出现多次` };
    }
    seenFileDataIds.add(x.dataId);
  }
  const existingByDataId = new Map<string, string>();
  if (seenFileDataIds.size > 0) {
    const foundRows = await prisma.requirement.findMany({
      where: { dataId: { in: Array.from(seenFileDataIds) } },
      select: { id: true, dataId: true },
    });
    for (const fr of foundRows) {
      if (fr.dataId) existingByDataId.set(fr.dataId, fr.id);
    }
  }

  try {
    let imported = 0;
    await prisma.$transaction(async (tx) => {
      const idMap = new Map<string, string>();
      for (const item of sorted) {
        const newParentId =
          item.parentOldId && idMap.has(item.parentOldId)
            ? idMap.get(item.parentOldId)!
            : null;
        const existingFromDataId =
          item.dataId && existingByDataId.get(item.dataId);
        if (existingFromDataId) {
          try {
            await tx.requirement.update({
              where: { id: existingFromDataId },
              data: {
                iterationId: iter,
                parentId: newParentId,
                title: item.title,
                taskProgress: item.taskProgress,
                latestProgress: item.latestProgress,
                priority: item.priority,
                status: item.status,
                submitter: item.submitter,
                devOwner: item.devOwner,
                testOwner: item.testOwner,
                planStartAt: item.planStartAt,
                planEndAt: item.planEndAt,
                dataId: item.dataId,
                wbsId: item.wbsId,
              },
            });
            idMap.set(item.oldId, existingFromDataId);
            imported++;
          } catch (e) {
            if (isUnknownField(e, "dataId")) {
              try {
                await tx.requirement.update({
                  where: { id: existingFromDataId },
                  data: {
                    iterationId: iter,
                    parentId: newParentId,
                    title: item.title,
                    taskProgress: item.taskProgress,
                    latestProgress: item.latestProgress,
                    priority: item.priority,
                    status: item.status,
                    submitter: item.submitter,
                    devOwner: item.devOwner,
                    testOwner: item.testOwner,
                    planStartAt: item.planStartAt,
                    planEndAt: item.planEndAt,
                    wbsId: item.wbsId,
                  },
                });
                idMap.set(item.oldId, existingFromDataId);
                imported++;
              } catch (e2) {
                if (isUnknownField(e2, "devOwner") || isUnknownField(e2, "testOwner")) {
                  try {
                    await tx.requirement.update({
                      where: { id: existingFromDataId },
                      data: {
                        iterationId: iter,
                        parentId: newParentId,
                        title: item.title,
                        taskProgress: item.taskProgress,
                        latestProgress: item.latestProgress,
                        priority: item.priority,
                        status: item.status,
                        submitter: item.submitter,
                        planStartAt: item.planStartAt,
                        planEndAt: item.planEndAt,
                        wbsId: item.wbsId,
                      },
                    });
                    idMap.set(item.oldId, existingFromDataId);
                    imported++;
                  } catch (e3) {
                    if (
                      isUnknownField(e3, "taskProgress") ||
                      isUnknownField(e3, "latestProgress")
                    ) {
                      await tx.requirement.update({
                        where: { id: existingFromDataId },
                        data: {
                          iterationId: iter,
                          parentId: newParentId,
                          title: item.title,
                          priority: item.priority,
                          status: item.status,
                          submitter: item.submitter,
                          planStartAt: item.planStartAt,
                          planEndAt: item.planEndAt,
                          wbsId: item.wbsId,
                        },
                      });
                      idMap.set(item.oldId, existingFromDataId);
                      imported++;
                    } else {
                      throw new Error(importRowFailureMessage(item, e3));
                    }
                  }
                } else if (
                  isUnknownField(e2, "taskProgress") ||
                  isUnknownField(e2, "latestProgress")
                ) {
                  try {
                    await tx.requirement.update({
                      where: { id: existingFromDataId },
                      data: {
                        iterationId: iter,
                        parentId: newParentId,
                        title: item.title,
                        priority: item.priority,
                        status: item.status,
                        submitter: item.submitter,
                        devOwner: item.devOwner,
                        testOwner: item.testOwner,
                        planStartAt: item.planStartAt,
                        planEndAt: item.planEndAt,
                        wbsId: item.wbsId,
                      },
                    });
                    idMap.set(item.oldId, existingFromDataId);
                    imported++;
                  } catch (e3) {
                    if (isUnknownField(e3, "devOwner") || isUnknownField(e3, "testOwner")) {
                      await tx.requirement.update({
                        where: { id: existingFromDataId },
                        data: {
                          iterationId: iter,
                          parentId: newParentId,
                          title: item.title,
                          priority: item.priority,
                          status: item.status,
                          submitter: item.submitter,
                          planStartAt: item.planStartAt,
                          planEndAt: item.planEndAt,
                          wbsId: item.wbsId,
                        },
                      });
                      idMap.set(item.oldId, existingFromDataId);
                      imported++;
                    } else {
                      throw new Error(importRowFailureMessage(item, e3));
                    }
                  }
                } else {
                  throw new Error(importRowFailureMessage(item, e2));
                }
              }
            } else if (isUnknownField(e, "devOwner") || isUnknownField(e, "testOwner")) {
              try {
                await tx.requirement.update({
                  where: { id: existingFromDataId },
                  data: {
                    iterationId: iter,
                    parentId: newParentId,
                    title: item.title,
                    taskProgress: item.taskProgress,
                    latestProgress: item.latestProgress,
                    priority: item.priority,
                    status: item.status,
                    submitter: item.submitter,
                    planStartAt: item.planStartAt,
                    planEndAt: item.planEndAt,
                    dataId: item.dataId,
                    wbsId: item.wbsId,
                  },
                });
                idMap.set(item.oldId, existingFromDataId);
                imported++;
              } catch (e2) {
                if (isUnknownField(e2, "dataId")) {
                  try {
                    await tx.requirement.update({
                      where: { id: existingFromDataId },
                      data: {
                        iterationId: iter,
                        parentId: newParentId,
                        title: item.title,
                        taskProgress: item.taskProgress,
                        latestProgress: item.latestProgress,
                        priority: item.priority,
                        status: item.status,
                        submitter: item.submitter,
                        planStartAt: item.planStartAt,
                        planEndAt: item.planEndAt,
                        wbsId: item.wbsId,
                      },
                    });
                    idMap.set(item.oldId, existingFromDataId);
                    imported++;
                  } catch (e3) {
                    if (
                      isUnknownField(e3, "taskProgress") ||
                      isUnknownField(e3, "latestProgress")
                    ) {
                      await tx.requirement.update({
                        where: { id: existingFromDataId },
                        data: {
                          iterationId: iter,
                          parentId: newParentId,
                          title: item.title,
                          priority: item.priority,
                          status: item.status,
                          submitter: item.submitter,
                          planStartAt: item.planStartAt,
                          planEndAt: item.planEndAt,
                          wbsId: item.wbsId,
                        },
                      });
                      idMap.set(item.oldId, existingFromDataId);
                      imported++;
                    } else {
                      throw new Error(importRowFailureMessage(item, e3));
                    }
                  }
                } else if (
                  isUnknownField(e2, "taskProgress") ||
                  isUnknownField(e2, "latestProgress")
                ) {
                  await tx.requirement.update({
                    where: { id: existingFromDataId },
                    data: {
                      iterationId: iter,
                      parentId: newParentId,
                      title: item.title,
                      priority: item.priority,
                      status: item.status,
                      submitter: item.submitter,
                      planStartAt: item.planStartAt,
                      planEndAt: item.planEndAt,
                      wbsId: item.wbsId,
                    },
                  });
                  idMap.set(item.oldId, existingFromDataId);
                  imported++;
                } else {
                  throw new Error(importRowFailureMessage(item, e2));
                }
              }
            } else if (
              isUnknownField(e, "taskProgress") ||
              isUnknownField(e, "latestProgress")
            ) {
              try {
                await tx.requirement.update({
                  where: { id: existingFromDataId },
                  data: {
                    iterationId: iter,
                    parentId: newParentId,
                    title: item.title,
                    priority: item.priority,
                    status: item.status,
                    submitter: item.submitter,
                    devOwner: item.devOwner,
                    testOwner: item.testOwner,
                    planStartAt: item.planStartAt,
                    planEndAt: item.planEndAt,
                    dataId: item.dataId,
                    wbsId: item.wbsId,
                  },
                });
                idMap.set(item.oldId, existingFromDataId);
                imported++;
              } catch (e2) {
                if (isUnknownField(e2, "dataId")) {
                  try {
                    await tx.requirement.update({
                      where: { id: existingFromDataId },
                      data: {
                        iterationId: iter,
                        parentId: newParentId,
                        title: item.title,
                        priority: item.priority,
                        status: item.status,
                        submitter: item.submitter,
                        devOwner: item.devOwner,
                        testOwner: item.testOwner,
                        planStartAt: item.planStartAt,
                        planEndAt: item.planEndAt,
                        wbsId: item.wbsId,
                      },
                    });
                    idMap.set(item.oldId, existingFromDataId);
                    imported++;
                  } catch (e3) {
                    if (isUnknownField(e3, "devOwner") || isUnknownField(e3, "testOwner")) {
                      await tx.requirement.update({
                        where: { id: existingFromDataId },
                        data: {
                          iterationId: iter,
                          parentId: newParentId,
                          title: item.title,
                          priority: item.priority,
                          status: item.status,
                          submitter: item.submitter,
                          planStartAt: item.planStartAt,
                          planEndAt: item.planEndAt,
                          wbsId: item.wbsId,
                        },
                      });
                      idMap.set(item.oldId, existingFromDataId);
                      imported++;
                    } else {
                      throw new Error(importRowFailureMessage(item, e3));
                    }
                  }
                } else if (isUnknownField(e2, "devOwner") || isUnknownField(e2, "testOwner")) {
                  await tx.requirement.update({
                    where: { id: existingFromDataId },
                    data: {
                      iterationId: iter,
                      parentId: newParentId,
                      title: item.title,
                      priority: item.priority,
                      status: item.status,
                      submitter: item.submitter,
                      planStartAt: item.planStartAt,
                      planEndAt: item.planEndAt,
                      wbsId: item.wbsId,
                    },
                  });
                  idMap.set(item.oldId, existingFromDataId);
                  imported++;
                } else {
                  throw new Error(importRowFailureMessage(item, e2));
                }
              }
            } else {
              throw new Error(importRowFailureMessage(item, e));
            }
          }
          continue;
        }

        const maxSort = await tx.requirement.aggregate({
          where: { iterationId: iter, parentId: newParentId },
          _max: { sortOrder: true },
        });
        const sortOrder = (maxSort._max.sortOrder ?? 0) + 1;
        try {
          const row = await tx.requirement.create({
            data: {
              iterationId: iter,
              parentId: newParentId,
              title: item.title,
              taskProgress: item.taskProgress,
              latestProgress: item.latestProgress,
              priority: item.priority,
              status: item.status,
              submitter: item.submitter,
              devOwner: item.devOwner,
              testOwner: item.testOwner,
              planStartAt: item.planStartAt,
              planEndAt: item.planEndAt,
              sortOrder,
              dataId: item.dataId,
              wbsId: item.wbsId,
            },
            select: { id: true },
          });
          idMap.set(item.oldId, row.id);
          imported++;
        } catch (e) {
          if (isUnknownField(e, "devOwner") || isUnknownField(e, "testOwner")) {
            try {
              const row = await tx.requirement.create({
                data: {
                  iterationId: iter,
                  parentId: newParentId,
                  title: item.title,
                  taskProgress: item.taskProgress,
                  latestProgress: item.latestProgress,
                  priority: item.priority,
                  status: item.status,
                  submitter: item.submitter,
                  planStartAt: item.planStartAt,
                  planEndAt: item.planEndAt,
                  sortOrder,
                  dataId: item.dataId,
                  wbsId: item.wbsId,
                },
                select: { id: true },
              });
              idMap.set(item.oldId, row.id);
              imported++;
            } catch (e2) {
              if (
                isUnknownField(e2, "taskProgress") ||
                isUnknownField(e2, "latestProgress")
              ) {
                const row = await tx.requirement.create({
                  data: {
                    iterationId: iter,
                    parentId: newParentId,
                    title: item.title,
                    priority: item.priority,
                    status: item.status,
                    submitter: item.submitter,
                    planStartAt: item.planStartAt,
                    planEndAt: item.planEndAt,
                    sortOrder,
                    dataId: item.dataId,
                    wbsId: item.wbsId,
                  },
                  select: { id: true },
                });
                idMap.set(item.oldId, row.id);
                imported++;
              } else {
                throw new Error(importRowFailureMessage(item, e2));
              }
            }
          } else if (
            isUnknownField(e, "taskProgress") ||
            isUnknownField(e, "latestProgress")
          ) {
            try {
              const row = await tx.requirement.create({
                data: {
                  iterationId: iter,
                  parentId: newParentId,
                  title: item.title,
                  priority: item.priority,
                  status: item.status,
                  submitter: item.submitter,
                  devOwner: item.devOwner,
                  testOwner: item.testOwner,
                  planStartAt: item.planStartAt,
                  planEndAt: item.planEndAt,
                  sortOrder,
                  dataId: item.dataId,
                  wbsId: item.wbsId,
                },
                select: { id: true },
              });
              idMap.set(item.oldId, row.id);
              imported++;
            } catch (e2) {
              if (isUnknownField(e2, "devOwner") || isUnknownField(e2, "testOwner")) {
                const row = await tx.requirement.create({
                  data: {
                    iterationId: iter,
                    parentId: newParentId,
                    title: item.title,
                    priority: item.priority,
                    status: item.status,
                    submitter: item.submitter,
                    planStartAt: item.planStartAt,
                    planEndAt: item.planEndAt,
                    sortOrder,
                    dataId: item.dataId,
                    wbsId: item.wbsId,
                  },
                  select: { id: true },
                });
                idMap.set(item.oldId, row.id);
                imported++;
              } else {
                throw new Error(importRowFailureMessage(item, e2));
              }
            }
          } else if (isUnknownField(e, "dataId")) {
            try {
              const row = await tx.requirement.create({
                data: {
                  iterationId: iter,
                  parentId: newParentId,
                  title: item.title,
                  taskProgress: item.taskProgress,
                  latestProgress: item.latestProgress,
                  priority: item.priority,
                  status: item.status,
                  submitter: item.submitter,
                  devOwner: item.devOwner,
                  testOwner: item.testOwner,
                  planStartAt: item.planStartAt,
                  planEndAt: item.planEndAt,
                  sortOrder,
                  wbsId: item.wbsId,
                },
                select: { id: true },
              });
              idMap.set(item.oldId, row.id);
              imported++;
            } catch (e2) {
              if (isUnknownField(e2, "devOwner") || isUnknownField(e2, "testOwner")) {
                try {
                  const row = await tx.requirement.create({
                    data: {
                      iterationId: iter,
                      parentId: newParentId,
                      title: item.title,
                      taskProgress: item.taskProgress,
                      latestProgress: item.latestProgress,
                      priority: item.priority,
                      status: item.status,
                      submitter: item.submitter,
                      planStartAt: item.planStartAt,
                      planEndAt: item.planEndAt,
                      sortOrder,
                      wbsId: item.wbsId,
                    },
                    select: { id: true },
                  });
                  idMap.set(item.oldId, row.id);
                  imported++;
                } catch (e3) {
                  if (
                    isUnknownField(e3, "taskProgress") ||
                    isUnknownField(e3, "latestProgress")
                  ) {
                    const row = await tx.requirement.create({
                      data: {
                        iterationId: iter,
                        parentId: newParentId,
                        title: item.title,
                        priority: item.priority,
                        status: item.status,
                        submitter: item.submitter,
                        planStartAt: item.planStartAt,
                        planEndAt: item.planEndAt,
                        sortOrder,
                        wbsId: item.wbsId,
                      },
                      select: { id: true },
                    });
                    idMap.set(item.oldId, row.id);
                    imported++;
                  } else {
                    throw new Error(importRowFailureMessage(item, e3));
                  }
                }
              } else if (
                isUnknownField(e2, "taskProgress") ||
                isUnknownField(e2, "latestProgress")
              ) {
                const row = await tx.requirement.create({
                  data: {
                    iterationId: iter,
                    parentId: newParentId,
                    title: item.title,
                    priority: item.priority,
                    status: item.status,
                    submitter: item.submitter,
                    devOwner: item.devOwner,
                    testOwner: item.testOwner,
                    planStartAt: item.planStartAt,
                    planEndAt: item.planEndAt,
                    sortOrder,
                    wbsId: item.wbsId,
                  },
                  select: { id: true },
                });
                idMap.set(item.oldId, row.id);
                imported++;
              } else {
                throw new Error(importRowFailureMessage(item, e2));
              }
            }
          } else {
            throw new Error(importRowFailureMessage(item, e));
          }
        }
      }
    });
    revalidatePath("/requirements");
    return { ok: true, imported };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function duplicateRequirementAsChild(
  parentId: string,
): Promise<ActionResult> {
  const pid = parentId.trim();
  if (!pid) return { error: "无效父节点" };
  try {
    const parent = await prisma.requirement.findUnique({
      where: { id: pid },
      select: {
        id: true,
        iterationId: true,
        title: true,
        description: true,
        taskProgress: true,
        latestProgress: true,
        priority: true,
        status: true,
        submitter: true,
        devOwner: true,
        testOwner: true,
        planStartAt: true,
        planEndAt: true,
        wbsId: true,
      },
    });
    if (!parent) return { error: "父节点不存在" };

    const siblingWbsRows = await prisma.requirement.findMany({
      where: { iterationId: parent.iterationId, parentId: parent.id },
      select: { wbsId: true },
    });
    const nextWbs = nextWbsForNewSiblingUnderParent(
      parent.wbsId,
      siblingWbsRows.map((s) => s.wbsId),
    );

    const maxSort = await prisma.requirement.aggregate({
      where: { iterationId: parent.iterationId, parentId: parent.id },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxSort._max.sortOrder ?? 0) + 1;

    try {
      await prisma.requirement.create({
        data: {
          iterationId: parent.iterationId,
          parentId: parent.id,
          title: parent.title,
          description: parent.description,
          taskProgress: parent.taskProgress,
          latestProgress: parent.latestProgress,
          priority: parent.priority,
          status: parent.status,
          submitter: parent.submitter,
          devOwner: parent.devOwner,
          testOwner: parent.testOwner,
          planStartAt: parent.planStartAt,
          planEndAt: parent.planEndAt,
          sortOrder,
          wbsId: nextWbs,
        },
        select: { id: true },
      });
    } catch (e) {
      if (isUnknownField(e, "devOwner") || isUnknownField(e, "testOwner")) {
        try {
          await prisma.requirement.create({
            data: {
              iterationId: parent.iterationId,
              parentId: parent.id,
              title: parent.title,
              description: parent.description,
              taskProgress: parent.taskProgress,
              latestProgress: parent.latestProgress,
              priority: parent.priority,
              status: parent.status,
              submitter: parent.submitter,
              planStartAt: parent.planStartAt,
              planEndAt: parent.planEndAt,
              sortOrder,
              wbsId: nextWbs,
            },
            select: { id: true },
          });
        } catch (e2) {
          if (
            isUnknownField(e2, "taskProgress") ||
            isUnknownField(e2, "latestProgress")
          ) {
            await prisma.requirement.create({
              data: {
                iterationId: parent.iterationId,
                parentId: parent.id,
                title: parent.title,
                description: parent.description,
                priority: parent.priority,
                status: parent.status,
                submitter: parent.submitter,
                planStartAt: parent.planStartAt,
                planEndAt: parent.planEndAt,
                sortOrder,
                wbsId: nextWbs,
              },
              select: { id: true },
            });
          } else {
            throw e2;
          }
        }
      } else if (
        isUnknownField(e, "taskProgress") ||
        isUnknownField(e, "latestProgress")
      ) {
        try {
          await prisma.requirement.create({
            data: {
              iterationId: parent.iterationId,
              parentId: parent.id,
              title: parent.title,
              description: parent.description,
              priority: parent.priority,
              status: parent.status,
              submitter: parent.submitter,
              devOwner: parent.devOwner,
              testOwner: parent.testOwner,
              planStartAt: parent.planStartAt,
              planEndAt: parent.planEndAt,
              sortOrder,
              wbsId: nextWbs,
            },
            select: { id: true },
          });
        } catch (e2) {
          if (isUnknownField(e2, "devOwner") || isUnknownField(e2, "testOwner")) {
            await prisma.requirement.create({
              data: {
                iterationId: parent.iterationId,
                parentId: parent.id,
                title: parent.title,
                description: parent.description,
                priority: parent.priority,
                status: parent.status,
                submitter: parent.submitter,
                planStartAt: parent.planStartAt,
                planEndAt: parent.planEndAt,
                sortOrder,
                wbsId: nextWbs,
              },
              select: { id: true },
            });
          } else {
            throw e2;
          }
        }
      } else {
        throw e;
      }
    }

    revalidatePath("/requirements");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function bulkDeleteRequirements(input: {
  iterationId: string;
  ids: string[];
}): Promise<ActionResult> {
  const iterationId = input.iterationId.trim();
  const ids = Array.from(new Set(input.ids.map((x) => x.trim()).filter(Boolean)));
  if (!iterationId) return { error: "请选择迭代" };
  if (ids.length === 0) return { error: "请选择要删除的需求" };
  try {
    const all = await prisma.requirement.findMany({
      where: { iterationId },
      select: { id: true, parentId: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const children = new Map<string, string[]>();
    for (const r of all) {
      if (!r.parentId) continue;
      const arr = children.get(r.parentId) ?? [];
      arr.push(r.id);
      children.set(r.parentId, arr);
    }
    const toDelete = new Set<string>();
    const stack = [...ids];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (toDelete.has(cur)) continue;
      toDelete.add(cur);
      for (const cid of children.get(cur) ?? []) stack.push(cid);
    }
    const deleteIds = Array.from(toDelete);
    const tdCount = await prisma.testDesign.count({
      where: { requirementId: { in: deleteIds } },
    });
    if (tdCount > 0) {
      return {
        error: `无法删除：所选范围（含子节点）下仍有关联的测试设计共 ${tdCount} 条。请先迁移、删除测试设计，或解除关联后再删除需求。`,
      };
    }
    await prisma.requirement.deleteMany({
      where: { id: { in: deleteIds } },
    });
    revalidatePath("/requirements");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function bulkMoveRequirements(input: {
  iterationId: string;
  ids: string[];
  targetParentId: string | null;
}): Promise<ActionResult> {
  const iterationId = input.iterationId.trim();
  const ids = Array.from(new Set(input.ids.map((x) => x.trim()).filter(Boolean)));
  const targetParentId = input.targetParentId ? input.targetParentId.trim() : null;
  if (!iterationId) return { error: "请选择迭代" };
  if (ids.length === 0) return { error: "请选择要移动的需求" };
  if (targetParentId && ids.includes(targetParentId)) {
    return { error: "不能移动到已选节点自身下面。" };
  }
  try {
    await prisma.requirement.updateMany({
      where: { iterationId, id: { in: ids } },
      data: { parentId: targetParentId },
    });
    revalidatePath("/requirements");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

