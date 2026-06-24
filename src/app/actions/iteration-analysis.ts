"use server";

import {
  createEmptyIterationAnalysis,
  normalizeIterationAnalysis,
  type IterationAnalysisData,
} from "@/lib/iterationAnalysis";
import { prisma } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export type IterationAnalysisListRow = {
  iterationId: string;
  iterationName: string;
  iterationCode: string;
  productId: string;
  productName: string;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  hasReport: boolean;
};

export async function listIterationAnalysisReports(filters?: {
  productId?: string | null;
  iterationId?: string | null;
}): Promise<IterationAnalysisListRow[]> {
  const productId = filters?.productId?.trim() || undefined;
  const iterationId = filters?.iterationId?.trim() || undefined;

  const rows = await prisma.iteration.findMany({
    where: {
      ...(productId ? { productId } : {}),
      ...(iterationId ? { id: iterationId } : {}),
    },
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      code: true,
      productId: true,
      product: { select: { name: true } },
      iterationAnalysis: {
        select: {
          createdBy: true,
          updatedBy: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  return rows.map((r) => {
    const a = r.iterationAnalysis;
    return {
      iterationId: r.id,
      iterationName: r.name,
      iterationCode: r.code,
      productId: r.productId,
      productName: r.product.name,
      createdBy: a?.createdBy ?? null,
      updatedBy: a?.updatedBy ?? null,
      createdAt: a?.createdAt?.toISOString() ?? null,
      updatedAt: a?.updatedAt?.toISOString() ?? null,
      hasReport: !!a,
    };
  });
}

export async function getIterationAnalysis(
  iterationId: string,
): Promise<IterationAnalysisData> {
  const id = iterationId.trim();
  if (!id) return createEmptyIterationAnalysis();
  try {
    const row = await prisma.iterationAnalysis.findUnique({
      where: { iterationId: id },
      select: { content: true },
    });
    if (!row?.content) return createEmptyIterationAnalysis();
    return normalizeIterationAnalysis(JSON.parse(row.content));
  } catch {
    return createEmptyIterationAnalysis();
  }
}

export async function saveIterationAnalysis(
  iterationId: string,
  data: IterationAnalysisData,
  meta?: { actor?: string | null },
): Promise<{ error?: string }> {
  const id = iterationId.trim();
  if (!id) return { error: "请选择迭代" };
  const actor = meta?.actor?.trim() || null;
  const iter = await prisma.iteration.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!iter) return { error: "迭代不存在" };
  const normalized = normalizeIterationAnalysis(data);
  try {
    const existing = await prisma.iterationAnalysis.findUnique({
      where: { iterationId: id },
      select: { id: true },
    });
    await prisma.iterationAnalysis.upsert({
      where: { iterationId: id },
      create: {
        iterationId: id,
        content: JSON.stringify(normalized),
        createdBy: actor,
        updatedBy: actor,
      },
      update: {
        content: JSON.stringify(normalized),
        updatedBy: actor,
      },
    });
    void existing;
    revalidatePath("/executions/iteration-analysis");
    return {};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IterationAnalysis") || msg.includes("does not exist")) {
      return {
        error: "迭代分析表不存在，请执行 npx prisma db push 后重试。",
      };
    }
    return { error: "保存失败，请稍后重试。" };
  }
}
