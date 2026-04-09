"use server";

import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type ProductActionState = { error?: string; ok?: boolean } | null;

function optString(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (raw === null || raw === "") return null;
  const s = String(raw).trim();
  return s || null;
}

function optDate(formData: FormData, key: string): Date | null {
  const s = optString(formData, key);
  if (!s) return null;
  const normalized = s.includes("T") ? s : `${s}T00:00:00`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseLevel(formData: FormData): number {
  const raw = formData.get("level");
  const n = Number.parseInt(String(raw ?? "1"), 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(n, 99);
}

async function assertParentIsLevelOne(
  parentId: string | null,
  level: number,
): Promise<string | null> {
  if (level === 1) {
    if (parentId) {
      return "一级项目不应关联其他一级项目，请清空「关联一级项目」";
    }
    return null;
  }
  if (!parentId) {
    return "项目层级大于 1 时必须选择关联的一级项目";
  }
  const parent = await prisma.product.findUnique({
    where: { id: parentId },
    select: { id: true, level: true },
  });
  if (!parent) {
    return "关联的一级项目不存在";
  }
  if (parent.level !== 1) {
    return "只能关联层级为 1 的一级项目";
  }
  return null;
}

export async function createProduct(
  _prev: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const level = parseLevel(formData);
  const parentIdRaw = optString(formData, "parentId");
  const owner = optString(formData, "owner");
  const department = optString(formData, "department");
  const teamMembers = optString(formData, "teamMembers");
  const startDate = optDate(formData, "startDate");
  const endDate = optDate(formData, "endDate");
  const description = optString(formData, "description");

  if (!name) {
    return { error: "项目名称不能为空" };
  }
  if (!code) {
    return { error: "项目编码不能为空" };
  }

  const parentErr = await assertParentIsLevelOne(parentIdRaw, level);
  if (parentErr) {
    return { error: parentErr };
  }

  try {
    await prisma.product.create({
      data: {
        name,
        code,
        level,
        parentId: level === 1 ? null : parentIdRaw,
        owner,
        department,
        teamMembers,
        startDate,
        endDate,
        description,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { error: "项目编码已存在，请更换" };
    }
    throw e;
  }

  revalidatePath("/");
  return { ok: true };
}

export async function updateProduct(
  _prev: ProductActionState,
  formData: FormData,
): Promise<ProductActionState> {
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim();
  const level = parseLevel(formData);
  const parentIdRaw = optString(formData, "parentId");
  const owner = optString(formData, "owner");
  const department = optString(formData, "department");
  const teamMembers = optString(formData, "teamMembers");
  const startDate = optDate(formData, "startDate");
  const endDate = optDate(formData, "endDate");
  const description = optString(formData, "description");

  if (!id) {
    return { error: "缺少项目标识" };
  }
  if (!name) {
    return { error: "项目名称不能为空" };
  }
  if (!code) {
    return { error: "项目编码不能为空" };
  }

  if (parentIdRaw === id) {
    return { error: "不能将本项目作为关联的一级项目" };
  }

  const parentErr = await assertParentIsLevelOne(parentIdRaw, level);
  if (parentErr) {
    return { error: parentErr };
  }

  try {
    await prisma.product.update({
      where: { id },
      data: {
        name,
        code,
        level,
        parentId: level === 1 ? null : parentIdRaw,
        owner,
        department,
        teamMembers,
        startDate,
        endDate,
        description,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { error: "项目编码已存在，请更换" };
    }
    throw e;
  }

  revalidatePath("/");
  return { ok: true };
}

export async function deleteProduct(productId: string): Promise<ProductActionState> {
  const id = String(productId).trim();
  if (!id) {
    return { error: "缺少项目标识" };
  }

  await prisma.product.delete({ where: { id } });
  revalidatePath("/");
  return { ok: true };
}

export type ProductOption = { id: string; name: string; code: string | null };

export async function listProductOptions(): Promise<ProductOption[]> {
  const db = prisma as unknown as {
    product: { findMany: (args: unknown) => Promise<unknown[]> };
  };
  const rows = (await db.product.findMany({
    orderBy: [{ updatedAt: "desc" }],
    select: { id: true, name: true, code: true },
    take: 500,
  })) as unknown as Array<{ id: string; name: string; code: string | null }>;
  return rows;
}
