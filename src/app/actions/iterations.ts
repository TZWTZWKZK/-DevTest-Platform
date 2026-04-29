"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { archiveTestDesignsBeforeRequirementDelete } from "@/app/actions/test-design";
import { prisma } from "@/lib/prisma";

export type ActionResult = { ok?: true; error?: string };

// 兼容：本地 Prisma Client 可能尚未 generate（如 Windows EPERM 被占用）
export type IterationStatus = "IN_PROGRESS" | "OVERDUE" | "COMPLETED";

function prismaKnownToMessage(e: Prisma.PrismaClientKnownRequestError): string {
  switch (e.code) {
    case "P2002":
      return "与已有数据冲突（例如迭代编码重复）。";
    case "P2022":
      return "数据库字段与当前程序不一致。请停止开发服务后执行 npx prisma generate，必要时 npx prisma db push，删除 .next 文件夹后重新启动。";
    case "P2025":
      return "记录不存在或已被删除。";
    case "P2003":
      return "存在关联数据，当前操作无法完成。";
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

function fmtDayLog(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export type ProductOption = { id: string; label: string };

export async function listProductOptions(): Promise<ProductOption[]> {
  const rows = await prisma.product.findMany({
    orderBy: [{ level: "asc" }, { name: "asc" }],
    select: { id: true, name: true, code: true },
  });
  return rows.map((p) => ({
    id: p.id,
    label: `${p.name}${p.code ? `（${p.code}）` : ""}`,
  }));
}

export type IterationRow = {
  id: string;
  name: string;
  code: string;
  content: string | null;
  startDate: string | null;
  endDate: string | null;
  status: IterationStatus;
  submitter: string | null;
  createdAt: string;
  updatedAt: string;
  productId: string;
};

export async function listIterationsByProduct(
  productId: string,
): Promise<IterationRow[]> {
  const id = productId.trim();
  if (!id) return [];
  const rows = await prisma.iteration.findMany({
    where: { productId: id },
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      code: true,
      content: true,
      startDate: true,
      endDate: true,
      status: true,
      submitter: true,
      createdAt: true,
      updatedAt: true,
      productId: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    content: r.content,
    startDate: r.startDate ? r.startDate.toISOString() : null,
    endDate: r.endDate ? r.endDate.toISOString() : null,
    status: r.status,
    submitter: r.submitter,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    productId: r.productId,
  }));
}

export type IterationCodeOption = { code: string; label: string };

/** baseline + 全部迭代（用于测试设计/用例库按迭代筛选） */
export async function listIterationCodeOptions(
  productId?: string | null,
): Promise<Array<IterationCodeOption & { productId: string | null }>> {
  const pid = (productId ?? "").trim();
  const rows = await prisma.iteration.findMany({
    where: pid ? { productId: pid } : undefined,
    include: { product: true },
    orderBy: [{ updatedAt: "desc" }],
  });
  const opts = rows.map((it) => ({
    code: it.code,
    label: `${it.product.name} / ${it.name}（${it.code}）`,
    productId: it.productId,
  }));
  return [{ code: "", label: "baseline（全部迭代）", productId: null }, ...opts];
}

function genIterationCode(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  return `IT-${y}${m}${d}-${hh}${mm}${ss}`;
}

export type IterationSaveInput = {
  id?: string;
  productId: string;
  name: string;
  content: string | null;
  startDate: string | null; // yyyy-mm-dd
  endDate: string | null; // yyyy-mm-dd
  status: IterationStatus;
  submitter: string | null;
};

export type IterationOpLogRow = {
  id: string;
  action: string;
  detail: string | null;
  createdAt: string;
};

export async function getIterationOpLogs(
  iterationId: string,
  take = 50,
): Promise<IterationOpLogRow[]> {
  const id = iterationId.trim();
  if (!id) return [];
  try {
    const rows = await prisma.iterationOpLog.findMany({
      where: { iterationId: id },
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

async function appendIterationOpLog(
  iterationId: string,
  action: string,
  detail?: string | null,
) {
  try {
    await prisma.iterationOpLog.create({
      data: {
        iterationId,
        action,
        detail: detail === undefined ? null : detail,
      },
    });
  } catch {
    /* 忽略日志写入失败 */
  }
}

export async function saveIteration(input: IterationSaveInput): Promise<ActionResult> {
  const name = input.name.trim();
  if (!input.productId) return { error: "请选择产品" };
  if (!name) return { error: "迭代名称不能为空" };

  const start = input.startDate ? new Date(`${input.startDate}T00:00:00`) : null;
  const end = input.endDate ? new Date(`${input.endDate}T23:59:59.999`) : null;
  if (start && Number.isNaN(start.getTime())) return { error: "开始时间无效" };
  if (end && Number.isNaN(end.getTime())) return { error: "结束时间无效" };
  if (start && end && start.getTime() > end.getTime())
    return { error: "开始时间不能晚于结束时间" };

  const statusLabel: Record<IterationStatus, string> = {
    IN_PROGRESS: "进行中",
    OVERDUE: "逾期",
    COMPLETED: "完成",
  };

  try {
    if (input.id) {
      const before = await prisma.iteration.findUnique({
        where: { id: input.id },
        select: {
          productId: true,
          name: true,
          content: true,
          startDate: true,
          endDate: true,
          status: true,
          submitter: true,
          product: { select: { name: true } },
        },
      });
      if (!before) return { error: "记录不存在或已被删除。" };

      await prisma.iteration.update({
        where: { id: input.id },
        data: {
          productId: input.productId,
          name,
          content: input.content,
          startDate: start,
          endDate: end,
          status: input.status,
          submitter: input.submitter,
        },
        select: { id: true },
      });

      const newProduct = await prisma.product.findUnique({
        where: { id: input.productId },
        select: { name: true },
      });

      const changes: string[] = [];
      if (before.productId !== input.productId) {
        changes.push(
          `所属产品：${before.product.name} → ${newProduct?.name ?? "（未知）"}`,
        );
      }
      if (before.name !== name) {
        changes.push(
          `名称：「${truncateForLog(before.name, 60)}」→「${truncateForLog(name, 60)}」`,
        );
      }
      const c0 = normDescLog(before.content);
      const c1 = normDescLog(input.content);
      if (c0 !== c1) {
        changes.push(
          `内容：「${truncateForLog(c0, 80)}」→「${truncateForLog(c1, 80)}」`,
        );
      }
      const ds0 = fmtDayLog(before.startDate);
      const ds1 = fmtDayLog(start);
      if (ds0 !== ds1) {
        changes.push(`开始时间：${ds0 || "空"} → ${ds1 || "空"}`);
      }
      const de0 = fmtDayLog(before.endDate);
      const de1 = fmtDayLog(end);
      if (de0 !== de1) {
        changes.push(`结束时间：${de0 || "空"} → ${de1 || "空"}`);
      }
      if (before.status !== input.status) {
        changes.push(
          `状态：${statusLabel[before.status]} → ${statusLabel[input.status]}`,
        );
      }
      const sub0 = normStrLog(before.submitter);
      const sub1 = normStrLog(input.submitter);
      if (sub0 !== sub1) {
        changes.push(`提交人：${sub0 || "空"} → ${sub1 || "空"}`);
      }

      await appendIterationOpLog(
        input.id,
        "更新迭代",
        changes.length > 0
          ? changes.join("；")
          : "（字段与保存前一致，无变更内容）",
      );
    } else {
      let code = genIterationCode(new Date());
      let row: { id: string; code: string };
      try {
        row = await prisma.iteration.create({
          data: {
            productId: input.productId,
            name,
            code,
            content: input.content,
            startDate: start,
            endDate: end,
            status: input.status,
            submitter: input.submitter,
          },
          select: { id: true, code: true },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          code = genIterationCode(new Date(Date.now() + 1000));
          row = await prisma.iteration.create({
            data: {
              productId: input.productId,
              name,
              code,
              content: input.content,
              startDate: start,
              endDate: end,
              status: input.status,
              submitter: input.submitter,
            },
            select: { id: true, code: true },
          });
        } else {
          throw e;
        }
      }
      const createParts = [
        `编码：${row.code}`,
        `名称：${name}`,
        `状态：${statusLabel[input.status]}`,
      ];
      const contentNorm = normDescLog(input.content);
      if (contentNorm)
        createParts.push(`内容：${truncateForLog(contentNorm, 80)}`);
      if (start) createParts.push(`开始：${fmtDayLog(start)}`);
      if (end) createParts.push(`结束：${fmtDayLog(end)}`);
      const sub = normStrLog(input.submitter);
      if (sub) createParts.push(`提交人：${sub}`);
      await appendIterationOpLog(row.id, "新建迭代", createParts.join("；"));
    }
    revalidatePath("/iterations");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function deleteIteration(id: string): Promise<ActionResult> {
  const i = id.trim();
  if (!i) return { error: "无效迭代" };
  try {
    await prisma.$transaction(async (tx) => {
      const reqs = await tx.requirement.findMany({
        where: { iterationId: i },
        select: { id: true },
      });
      await archiveTestDesignsBeforeRequirementDelete(
        tx,
        reqs.map((r) => r.id),
      );
      await tx.iteration.delete({ where: { id: i }, select: { id: true } });
    });
    revalidatePath("/iterations");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

