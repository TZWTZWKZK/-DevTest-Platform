"use server";

import { randomUUID } from "node:crypto";
import { type Prisma, type RequirementStatus, type TestDesignType } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  formatCaseLevelOpLog,
  parseCaseLevelOrNull,
} from "@/lib/case-level";
import { testDesignTypeLabel } from "@/lib/test-labels";

function isUnknownField(e: unknown, field: string): boolean {
  if (!(e instanceof Error)) return false;
  // Prisma Client 版本不一致时，可能报 Unknown field 或 Unknown argument
  return (
    e.message.includes(`Unknown field \`${field}\``) ||
    e.message.includes(`Unknown argument \`${field}\``)
  );
}

const DESIGN_BODY_MARK = "---PM_TEST_DESIGN_BODY_JSON---";

type DesignBody = {
  precondition: string | null;
  operationSteps: string | null;
  expectedResult: string | null;
  remark: string | null;
};

function stripMarkBlock(s: string): string {
  const idx = s.indexOf(DESIGN_BODY_MARK);
  if (idx < 0) return s;
  return s.slice(0, idx).trimEnd();
}

function packDescriptionWithBody(base: string | null, body: DesignBody): string {
  const head = (base ?? "").trim();
  const payload = JSON.stringify(body);
  const block = `${DESIGN_BODY_MARK}\n${payload}\n${DESIGN_BODY_MARK}`;
  return head ? `${head}\n\n${block}` : block;
}

function unpackBodyFromDescription(desc: string | null): {
  baseDescription: string | null;
  body: DesignBody;
} {
  const empty: DesignBody = {
    precondition: null,
    operationSteps: null,
    expectedResult: null,
    remark: null,
  };
  if (!desc) return { baseDescription: null, body: empty };
  const start = desc.indexOf(DESIGN_BODY_MARK);
  if (start < 0) return { baseDescription: desc, body: empty };
  const after = desc.indexOf("\n", start);
  const end = desc.indexOf(DESIGN_BODY_MARK, after < 0 ? start : after + 1);
  if (after < 0 || end < 0) return { baseDescription: stripMarkBlock(desc), body: empty };
  const json = desc.slice(after + 1, end).trim();
  try {
    const parsed = JSON.parse(json) as Partial<DesignBody>;
    return {
      baseDescription: stripMarkBlock(desc) || null,
      body: {
        precondition: typeof parsed.precondition === "string" ? parsed.precondition : null,
        operationSteps: typeof parsed.operationSteps === "string" ? parsed.operationSteps : null,
        expectedResult: typeof parsed.expectedResult === "string" ? parsed.expectedResult : null,
        remark: typeof parsed.remark === "string" ? parsed.remark : null,
      },
    };
  } catch {
    return { baseDescription: stripMarkBlock(desc) || null, body: empty };
  }
}

export type RequirementOption = { id: string; label: string; depth: number };

export type RequirementTreeFlat = {
  id: string;
  title: string;
  wbsId: string | null;
  status: RequirementStatus;
  testOwner: string | null;
  parentId: string | null;
  iterationId: string;
  iterationLabel: string;
};

export async function listRequirementsForDesignTree(
  iterationCode?: string | null,
): Promise<RequirementTreeFlat[]> {
  // baseline 不是实际迭代：不展示任何需求
  if (iterationCode === "") return [];
  const rows = await prisma.requirement.findMany({
    where: iterationCode ? { iteration: { code: iterationCode } } : undefined,
    include: { iteration: { include: { product: true } } },
    orderBy: [{ iterationId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    wbsId: r.wbsId ?? null,
    status: r.status,
    testOwner: r.testOwner ?? null,
    parentId: r.parentId,
    iterationId: r.iterationId,
    iterationLabel: `${r.iteration.product.name} / ${r.iteration.name}`,
  }));
}

export async function listRequirementOptions(
  iterationCode?: string | null,
): Promise<RequirementOption[]> {
  const reqs = await prisma.requirement.findMany({
    where: iterationCode ? { iteration: { code: iterationCode } } : undefined,
    include: { iteration: { include: { product: true } } },
    orderBy: [{ iterationId: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const byId = new Map(reqs.map((r) => [r.id, r]));

  const buildPath = (id: string): { parts: string[]; depth: number } => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.title);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return { parts, depth: Math.max(0, parts.length - 1) };
  };

  return reqs.map((r) => ({
    id: r.id,
    label: (() => {
      const { depth } = buildPath(r.id);
      const indent = depth > 0 ? `${"└─".repeat(depth)} ` : "";
      // select option 里多个空格可能不明显，用连字符更稳定
      return `${r.iteration.product.name} / ${r.iteration.name} / ${indent}${r.title}`;
    })(),
    depth: buildPath(r.id).depth,
  }));
}

export type TestDesignFlat = {
  id: string;
  title: string;
  type: TestDesignType;
  dirId: string | null;
  parentId: string | null;
  requirementId: string;
  sortOrder: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  linkedCaseCount: number;
};

type TestDesignWithCaseLinks = Prisma.TestDesignGetPayload<{
  include: { linkedTestCases: { select: { testCaseId: true } } };
}>;

async function insertTestDesignDeletedMany(
  tx: Prisma.TransactionClient,
  rows: TestDesignWithCaseLinks[],
): Promise<void> {
  if (rows.length === 0) return;
  const deletedAt = new Date();
  await tx.testDesignDeleted.createMany({
    data: rows.map((row) => ({
      originalId: row.id,
      title: row.title,
      description: row.description,
      type: row.type,
      dirId: row.dirId,
      iterationCode: row.iterationCode,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      precondition: row.precondition,
      operationSteps: row.operationSteps,
      expectedResult: row.expectedResult,
      remark: row.remark,
      caseLevel: row.caseLevel,
      requirementId: row.requirementId,
      parentId: row.parentId,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt,
      linkedTestCaseIds: row.linkedTestCases.map((l) => l.testCaseId),
    })),
  });
}

/** 展开根 id 下的整棵子树（删除前需与数据库级联范围一致） */
async function collectTestDesignSubtreeIds(
  rootIds: string[],
  tx: Prisma.TransactionClient,
): Promise<string[]> {
  const uniq = Array.from(new Set(rootIds.map((x) => x.trim()).filter(Boolean)));
  if (uniq.length === 0) return [];
  const roots = await tx.testDesign.findMany({
    where: { id: { in: uniq } },
    select: { requirementId: true },
  });
  if (roots.length === 0) return [];
  const reqIds = [...new Set(roots.map((r) => r.requirementId))];
  const all = await tx.testDesign.findMany({
    where: { requirementId: { in: reqIds } },
    select: { id: true, parentId: true },
  });
  const byParent = new Map<string | null, string[]>();
  for (const row of all) {
    const k = row.parentId ?? null;
    const arr = byParent.get(k) ?? [];
    arr.push(row.id);
    byParent.set(k, arr);
  }
  const out = new Set<string>();
  const dfs = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    for (const cid of byParent.get(id) ?? []) dfs(cid);
  };
  for (const r of uniq) dfs(r);
  return [...out];
}

/** 删除需求前归档其下全部测试设计（与 requirement 删除同事务调用） */
export async function archiveTestDesignsBeforeRequirementDelete(
  tx: Prisma.TransactionClient,
  requirementIds: string[],
): Promise<void> {
  const ids = [...new Set(requirementIds.map((x) => x.trim()).filter(Boolean))];
  if (ids.length === 0) return;
  const rows = await tx.testDesign.findMany({
    where: { requirementId: { in: ids } },
    include: { linkedTestCases: { select: { testCaseId: true } } },
  });
  await insertTestDesignDeletedMany(tx, rows);
}

export async function getTestDesignFlat(input: {
  requirementId: string;
  iterationCode: string; // "" 表示 baseline 模板
  type: TestDesignType;
  dirId?: string | null;
}): Promise<TestDesignFlat[]> {
  const requirementId = input.requirementId.trim();
  if (!requirementId) return [];

  // baseline 数据需要清空且不再作为模板来源
  if (input.iterationCode === "") {
    await prisma.$transaction(async (tx) => {
      const victims = await tx.testDesign.findMany({
        where: { requirementId, iterationCode: "", type: input.type },
        include: { linkedTestCases: { select: { testCaseId: true } } },
      });
      await insertTestDesignDeletedMany(tx, victims);
      await tx.testDesign.deleteMany({
        where: { requirementId, iterationCode: "", type: input.type },
      });
    });
    return [];
  }

  try {
    const rows = (await prisma.testDesign.findMany({
      where: {
        requirementId,
        iterationCode: input.iterationCode,
        type: input.type,
        ...(input.dirId ? { dirId: input.dirId } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        type: true,
        dirId: true,
        parentId: true,
        requirementId: true,
        sortOrder: true,
        createdBy: true,
        updatedBy: true,
        createdAt: true,
        updatedAt: true,
      } as unknown as Record<string, boolean>,
    })) as unknown as Array<{
      id: string;
      title: string;
      type: TestDesignType;
      dirId: string | null;
      parentId: string | null;
      requirementId: string;
      sortOrder: number;
      createdBy?: string | null;
      updatedBy?: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    const ids = rows.map((r) => r.id);
    const counts = await prisma.testDesignTestCase.groupBy({
      by: ["testDesignId"],
      where: { testDesignId: { in: ids } },
      _count: { _all: true },
    });
    const countById = new Map<string, number>(
      counts.map((c) => [c.testDesignId, c._count._all] as const),
    );
    return rows.map(
      (r): TestDesignFlat => ({
        id: r.id,
        title: r.title,
        type: r.type,
        dirId: r.dirId ?? null,
        parentId: r.parentId,
        requirementId: r.requirementId,
        sortOrder: r.sortOrder,
        createdBy: r.createdBy ?? null,
        updatedBy: r.updatedBy ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        linkedCaseCount: countById.get(r.id) ?? 0,
      }),
    );
  } catch (e) {
    // 兼容：旧 Prisma Client 不认识 createdBy/updatedBy
    if (isUnknownField(e, "createdBy") || isUnknownField(e, "updatedBy")) {
      const rows = await prisma.testDesign.findMany({
        where: {
          requirementId,
          iterationCode: input.iterationCode,
          type: input.type,
          ...(input.dirId ? { dirId: input.dirId } : {}),
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          type: true,
          dirId: true,
          parentId: true,
          requirementId: true,
          sortOrder: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const ids = rows.map((r) => r.id);
      const counts = await prisma.testDesignTestCase.groupBy({
        by: ["testDesignId"],
        where: { testDesignId: { in: ids } },
        _count: { _all: true },
      });
      const countById = new Map<string, number>(
        counts.map((c) => [c.testDesignId, c._count._all] as const),
      );
      return rows.map((r) => ({
        ...r,
        dirId: (r as unknown as { dirId?: string | null }).dirId ?? null,
        createdBy: null,
        updatedBy: null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        linkedCaseCount: countById.get(r.id) ?? 0,
      }));
    }
    throw e;
  }
}

export async function getTestDesignFlatForRequirements(input: {
  requirementIds: string[];
  iterationCode: string; // "" 表示 baseline 模板
  type: TestDesignType;
  dirId?: string | null;
}): Promise<TestDesignFlat[]> {
  const requirementIds = Array.from(
    new Set(input.requirementIds.map((x) => x.trim()).filter(Boolean)),
  );
  if (requirementIds.length === 0) return [];

  // baseline 数据需要清空且不再作为模板来源（子树场景按批量处理）
  if (input.iterationCode === "") {
    await prisma.$transaction(async (tx) => {
      const victims = await tx.testDesign.findMany({
        where: { requirementId: { in: requirementIds }, iterationCode: "", type: input.type },
        include: { linkedTestCases: { select: { testCaseId: true } } },
      });
      await insertTestDesignDeletedMany(tx, victims);
      await tx.testDesign.deleteMany({
        where: { requirementId: { in: requirementIds }, iterationCode: "", type: input.type },
      });
    });
    return [];
  }

  try {
    const rows = (await prisma.testDesign.findMany({
      where: {
        requirementId: { in: requirementIds },
        iterationCode: input.iterationCode,
        type: input.type,
        ...(input.dirId ? { dirId: input.dirId } : {}),
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        type: true,
        dirId: true,
        parentId: true,
        requirementId: true,
        sortOrder: true,
        createdBy: true,
        updatedBy: true,
        createdAt: true,
        updatedAt: true,
      } as unknown as Record<string, boolean>,
    })) as unknown as Array<{
      id: string;
      title: string;
      type: TestDesignType;
      dirId: string | null;
      parentId: string | null;
      requirementId: string;
      sortOrder: number;
      createdBy?: string | null;
      updatedBy?: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    const ids = rows.map((r) => r.id);
    const counts = await prisma.testDesignTestCase.groupBy({
      by: ["testDesignId"],
      where: { testDesignId: { in: ids } },
      _count: { _all: true },
    });
    const countById = new Map<string, number>(
      counts.map((c) => [c.testDesignId, c._count._all] as const),
    );
    return rows.map(
      (r): TestDesignFlat => ({
        id: r.id,
        title: r.title,
        type: r.type,
        dirId: r.dirId ?? null,
        parentId: r.parentId,
        requirementId: r.requirementId,
        sortOrder: r.sortOrder,
        createdBy: r.createdBy ?? null,
        updatedBy: r.updatedBy ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        linkedCaseCount: countById.get(r.id) ?? 0,
      }),
    );
  } catch (e) {
    if (isUnknownField(e, "createdBy") || isUnknownField(e, "updatedBy")) {
      const rows = await prisma.testDesign.findMany({
        where: {
          requirementId: { in: requirementIds },
          iterationCode: input.iterationCode,
          type: input.type,
          ...(input.dirId ? { dirId: input.dirId } : {}),
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          type: true,
          dirId: true,
          parentId: true,
          requirementId: true,
          sortOrder: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const ids = rows.map((r) => r.id);
      const counts = await prisma.testDesignTestCase.groupBy({
        by: ["testDesignId"],
        where: { testDesignId: { in: ids } },
        _count: { _all: true },
      });
      const countById = new Map<string, number>(
        counts.map((c) => [c.testDesignId, c._count._all] as const),
      );
      return rows.map((r) => ({
        ...r,
        dirId: (r as unknown as { dirId?: string | null }).dirId ?? null,
        createdBy: null,
        updatedBy: null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        linkedCaseCount: countById.get((r as unknown as { id: string }).id) ?? 0,
      }));
    }
    throw e;
  }
}

export async function countTestDesignByType(input: {
  requirementId: string;
  iterationCode: string;
}): Promise<Record<TestDesignType, number>> {
  const requirementId = input.requirementId.trim();
  if (!requirementId) {
    return {
      FUNCTIONAL: 0,
      PERFORMANCE: 0,
      SECURITY: 0,
      COMPATIBILITY: 0,
      USABILITY: 0,
      RELIABILITY: 0,
      OTHER: 0,
    };
  }
  if (input.iterationCode === "") {
    return {
      FUNCTIONAL: 0,
      PERFORMANCE: 0,
      SECURITY: 0,
      COMPATIBILITY: 0,
      USABILITY: 0,
      RELIABILITY: 0,
      OTHER: 0,
    };
  }
  const rows = await prisma.testDesign.groupBy({
    by: ["type"],
    where: {
      requirementId,
      iterationCode: input.iterationCode,
    },
    _count: { _all: true },
  });
  const out: Record<TestDesignType, number> = {
    FUNCTIONAL: 0,
    PERFORMANCE: 0,
    SECURITY: 0,
    COMPATIBILITY: 0,
    USABILITY: 0,
    RELIABILITY: 0,
    OTHER: 0,
  };
  for (const r of rows) out[r.type] = r._count._all;
  return out;
}

export async function countTestDesignByTypeForRequirements(input: {
  requirementIds: string[];
  iterationCode: string;
}): Promise<Record<TestDesignType, number>> {
  const requirementIds = Array.from(
    new Set(input.requirementIds.map((x) => x.trim()).filter(Boolean)),
  );
  if (requirementIds.length === 0 || input.iterationCode === "") {
    return {
      FUNCTIONAL: 0,
      PERFORMANCE: 0,
      SECURITY: 0,
      COMPATIBILITY: 0,
      USABILITY: 0,
      RELIABILITY: 0,
      OTHER: 0,
    };
  }
  const rows = await prisma.testDesign.groupBy({
    by: ["type"],
    where: {
      requirementId: { in: requirementIds },
      iterationCode: input.iterationCode,
    },
    _count: { _all: true },
  });
  const out: Record<TestDesignType, number> = {
    FUNCTIONAL: 0,
    PERFORMANCE: 0,
    SECURITY: 0,
    COMPATIBILITY: 0,
    USABILITY: 0,
    RELIABILITY: 0,
    OTHER: 0,
  };
  for (const r of rows) out[r.type] = r._count._all;
  return out;
}

export async function countTestDesignByDirSubtree(input: {
  requirementId: string;
  iterationCode: string;
}): Promise<{ counts?: Record<string, number>; error?: string }> {
  const requirementId = input.requirementId.trim();
  const iterationCode = input.iterationCode.trim();
  if (!requirementId) return { counts: {} };
  if (!iterationCode) return { counts: {} };

  try {
    const rows = await prisma.testDesign.findMany({
      where: { requirementId, iterationCode, dirId: { not: null } },
      select: { dirId: true } as unknown as Record<string, boolean>,
    });
    const typed = rows as unknown as Array<{ dirId: string | null }>;
    const direct = new Map<string, number>();
    for (const r of typed) {
      if (!r.dirId) continue;
      direct.set(r.dirId, (direct.get(r.dirId) ?? 0) + 1);
    }

    const it = await prisma.requirement.findUnique({
      where: { id: requirementId },
      select: { iterationId: true },
    });
    if (!it) return { counts: Object.fromEntries(direct.entries()) };

    const dirs = await prisma.testDesignDir.findMany({
      where: { iterationId: it.iterationId },
      select: { id: true, parentId: true },
    });
    const parentById = new Map(dirs.map((d) => [d.id, d.parentId ?? null] as const));

    const total = new Map<string, number>(direct);
    for (const [id, cnt] of direct.entries()) {
      let cur = parentById.get(id) ?? null;
      while (cur) {
        total.set(cur, (total.get(cur) ?? 0) + cnt);
        cur = parentById.get(cur) ?? null;
      }
    }
    return { counts: Object.fromEntries(total.entries()) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "统计失败" };
  }
}

export async function countTestDesignByDirSubtreeForRequirements(input: {
  requirementIds: string[];
  iterationCode: string;
}): Promise<{ counts?: Record<string, number>; error?: string }> {
  const requirementIds = Array.from(
    new Set(input.requirementIds.map((x) => x.trim()).filter(Boolean)),
  );
  const iterationCode = input.iterationCode.trim();
  if (requirementIds.length === 0) return { counts: {} };
  if (!iterationCode) return { counts: {} };

  try {
    const rows = await prisma.testDesign.findMany({
      where: {
        requirementId: { in: requirementIds },
        iterationCode,
        dirId: { not: null },
      },
      select: { dirId: true } as unknown as Record<string, boolean>,
    });
    const typed = rows as unknown as Array<{ dirId: string | null }>;
    const direct = new Map<string, number>();
    for (const r of typed) {
      if (!r.dirId) continue;
      direct.set(r.dirId, (direct.get(r.dirId) ?? 0) + 1);
    }

    const it = await prisma.requirement.findFirst({
      where: { id: { in: requirementIds } },
      select: { iterationId: true },
    });
    if (!it) return { counts: Object.fromEntries(direct.entries()) };

    const dirs = await prisma.testDesignDir.findMany({
      where: { iterationId: it.iterationId },
      select: { id: true, parentId: true },
    });
    const parentById = new Map(
      dirs.map((d) => [d.id, d.parentId ?? null] as const),
    );

    const total = new Map<string, number>(direct);
    for (const [id, cnt] of direct.entries()) {
      let cur = parentById.get(id) ?? null;
      while (cur) {
        total.set(cur, (total.get(cur) ?? 0) + cnt);
        cur = parentById.get(cur) ?? null;
      }
    }
    return { counts: Object.fromEntries(total.entries()) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "统计失败" };
  }
}

/** 隐藏侧栏类别前：仍存在的设计条数（iterationCode 为空则跨全部迭代统计） */
export async function countTestDesignsForCategoryHide(input: {
  type: TestDesignType;
  iterationCode: string;
}): Promise<{ count: number } | { error: string }> {
  try {
    const code = input.iterationCode.trim();
    const where: Prisma.TestDesignWhereInput = { type: input.type };
    if (code) where.iterationCode = code;
    const count = await prisma.testDesign.count({ where });
    return { count };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "统计失败" };
  }
}

/** 隐藏自定义「其他」子目录前：按标题前缀【标签】统计 */
export async function countTestDesignsForCustomDirHide(input: {
  customDirLabel: string;
  iterationCode: string;
}): Promise<{ count: number } | { error: string }> {
  try {
    const label = input.customDirLabel.trim();
    if (!label) return { count: 0 };
    const tag = `【${label}】`;
    const code = input.iterationCode.trim();
    const where: Prisma.TestDesignWhereInput = {
      type: "OTHER",
      title: { startsWith: tag },
    };
    if (code) where.iterationCode = code;
    const count = await prisma.testDesign.count({ where });
    return { count };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "统计失败" };
  }
}

export async function countTestDesignByRequirement(input: {
  iterationCode: string;
  requirementIds: string[];
}): Promise<Record<string, number>> {
  const ids = Array.from(
    new Set(input.requirementIds.map((x) => x.trim()).filter(Boolean)),
  );
  if (input.iterationCode === "" || ids.length === 0) return {};
  const rows = await prisma.testDesign.groupBy({
    by: ["requirementId"],
    where: { iterationCode: input.iterationCode, requirementId: { in: ids } },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.requirementId] = r._count._all;
  return out;
}

export type ActionResult = { ok?: true; error?: string };

export type TestDesignExportRow = {
  标题: string;
  类型: string;
  创建人: string;
  修改人: string;
  创建时间: string;
  更新时间: string;
};

export async function getTestDesignsExportRows(
  ids: string[],
): Promise<{ rows?: TestDesignExportRow[]; error?: string }> {
  try {
    const uniq = Array.from(new Set(ids.map((x) => x.trim()).filter(Boolean)));
    if (uniq.length === 0) return { rows: [] };
    const rows = await prisma.testDesign.findMany({
      where: { id: { in: uniq } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        title: true,
        type: true,
        createdBy: true,
        updatedBy: true,
        createdAt: true,
        updatedAt: true,
      } as unknown as Record<string, boolean>,
    });
    const typed = rows as unknown as Array<{
      title: string;
      type: TestDesignType;
      createdBy?: string | null;
      updatedBy?: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    return {
      rows: typed.map((r) => ({
        标题: r.title,
        类型: String(r.type),
        创建人: r.createdBy ?? "",
        修改人: r.updatedBy ?? "",
        创建时间: r.createdAt.toISOString(),
        更新时间: r.updatedAt.toISOString(),
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "导出失败" };
  }
}

export async function bulkDeleteTestDesignNodes(ids: string[]): Promise<ActionResult> {
  const uniq = Array.from(new Set(ids.map((x) => x.trim()).filter(Boolean)));
  if (uniq.length === 0) return { error: "请选择要删除的数据" };
  try {
    await prisma.$transaction(async (tx) => {
      const toDelete = await collectTestDesignSubtreeIds(uniq, tx);
      if (toDelete.length === 0) return;
      const rows = await tx.testDesign.findMany({
        where: { id: { in: toDelete } },
        include: { linkedTestCases: { select: { testCaseId: true } } },
      });
      await insertTestDesignDeletedMany(tx, rows);
      await tx.testDesign.deleteMany({ where: { id: { in: toDelete } } });
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "批量删除失败" };
  }
  revalidatePath("/test-design");
  return { ok: true };
}

export async function bulkMoveTestDesignNodes(input: {
  ids: string[];
  targetRequirementId: string;
}): Promise<ActionResult> {
  const uniq = Array.from(new Set(input.ids.map((x) => x.trim()).filter(Boolean)));
  const target = input.targetRequirementId.trim();
  if (!target) return { error: "请选择目标需求" };
  if (uniq.length === 0) return { error: "请选择要移动的数据" };
  const req = await prisma.requirement.findUnique({
    where: { id: target },
    select: { id: true, iteration: { select: { code: true } } },
  });
  if (!req) return { error: "目标需求不存在或已删除" };
  const targetIterCode = req.iteration.code;
  await prisma.testDesign.updateMany({
    where: { id: { in: uniq } },
    data: { requirementId: target, parentId: null, iterationCode: targetIterCode },
  });
  revalidatePath("/test-design");
  return { ok: true };
}

/** 将源需求下的全部测试设计迁入目标需求（树结构打平为根，迭代编码随目标需求） */
export async function bulkMoveAllTestDesignsBetweenRequirements(input: {
  sourceRequirementId: string;
  targetRequirementId: string;
}): Promise<ActionResult & { moved?: number }> {
  const from = input.sourceRequirementId.trim();
  const to = input.targetRequirementId.trim();
  if (!from || !to) return { error: "请选择源需求与目标需求" };
  if (from === to) return { error: "源需求与目标需求不能相同" };
  const target = await prisma.requirement.findUnique({
    where: { id: to },
    select: { id: true, iteration: { select: { code: true } } },
  });
  if (!target) return { error: "目标需求不存在或已删除" };
  const source = await prisma.requirement.findUnique({
    where: { id: from },
    select: { id: true },
  });
  if (!source) return { error: "源需求不存在或已删除" };
  const targetIterCode = target.iteration.code;
  const r = await prisma.testDesign.updateMany({
    where: { requirementId: from },
    data: { requirementId: to, parentId: null, iterationCode: targetIterCode },
  });
  revalidatePath("/test-design");
  return { ok: true, moved: r.count };
}

export async function bulkDuplicateTestDesignNodes(input: {
  ids: string[];
  /** 复制后强制落入的类别（用于“当前类别里复制”） */
  targetType: TestDesignType;
  /**
   * 复制后强制落入的目录：
   * - string：写入指定目录（会校验该目录属于 targetType）
   * - null：清空目录（落在类别根）
   * - undefined：不指定（按原逻辑，可用于未来保留源目录）
   */
  targetDirId?: string | null;
}): Promise<ActionResult & { duplicated?: number }> {
  const uniq = Array.from(new Set(input.ids.map((x) => x.trim()).filter(Boolean)));
  if (uniq.length === 0) return { error: "请选择要复制的数据" };
  const targetType = input.targetType;
  const targetDirId =
    input.targetDirId === undefined ? undefined : input.targetDirId?.trim() || null;
  try {
    let duplicated = 0;
    await prisma.$transaction(async (tx) => {
      // 若指定目标目录：确保目录存在且属于 targetType
      if (targetDirId) {
        const dir = await tx.testDesignDir.findUnique({
          where: { id: targetDirId },
          select: { id: true, type: true },
        });
        if (!dir) throw new Error("目标目录不存在或已删除");
        if (dir.type !== targetType) throw new Error("目标目录不属于当前类别");
      }

      const rows = await tx.testDesign.findMany({
        where: { id: { in: uniq } },
        select: {
          id: true,
          requirementId: true,
          parentId: true,
          sortOrder: true,
          title: true,
          description: true,
          type: true,
          iterationCode: true,
          dirId: true,
          createdBy: true,
          updatedBy: true,
          precondition: true,
          operationSteps: true,
          expectedResult: true,
          remark: true,
        } as unknown as Record<string, boolean>,
      });
      const typed = rows as unknown as Array<{
        id: string;
        requirementId: string;
        parentId: string | null;
        sortOrder: number;
        title: string;
        description?: string | null;
        type: TestDesignType;
        iterationCode?: string | null;
        dirId?: string | null;
        createdBy?: string | null;
        updatedBy?: string | null;
        precondition?: string | null;
        operationSteps?: string | null;
        expectedResult?: string | null;
        remark?: string | null;
      }>;

      // 保持顺序：按原 sortOrder 复制，新的节点放到同父节点下末尾
      const byParent = new Map<string, Array<(typeof typed)[number]>>();
      for (const r of typed) {
        const k = r.parentId ?? "__root__";
        const arr = byParent.get(k) ?? [];
        arr.push(r);
        byParent.set(k, arr);
      }
      for (const [, arr] of byParent) {
        arr.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      }

      for (const [k, arr] of byParent) {
        const parentId = k === "__root__" ? null : k;
        const nextDirId =
          targetDirId === undefined ? (arr[0]!.dirId ?? null) : targetDirId;
        const max = await tx.testDesign.aggregate({
          where: {
            requirementId: arr[0]!.requirementId,
            parentId,
            type: targetType,
            dirId: nextDirId,
          },
          _max: { sortOrder: true },
        });
        let nextSort = (max._max.sortOrder ?? 0) + 1;
        for (const r of arr) {
          await tx.testDesign.create({
            data: {
              requirementId: r.requirementId,
              parentId: r.parentId,
              sortOrder: nextSort++,
              title: `${r.title}（复制）`,
              description: r.description ?? null,
              type: targetType,
              iterationCode: r.iterationCode ?? null,
              dirId: nextDirId,
              createdBy: r.createdBy ?? null,
              updatedBy: r.updatedBy ?? null,
              precondition: r.precondition ?? null,
              operationSteps: r.operationSteps ?? null,
              expectedResult: r.expectedResult ?? null,
              remark: r.remark ?? null,
            } as Prisma.TestDesignUncheckedCreateInput,
            select: { id: true },
          });
          // 注意：不复制 testDesignTestCase，不写 testDesignOpLog → “操作记录”为空
          duplicated++;
        }
      }
    });
    revalidatePath("/test-design");
    return { ok: true, duplicated };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "复制失败" };
  }
}

export async function bulkUpdateTestDesignNodes(input: {
  ids: string[];
  type?: TestDesignType | null;
  dirId?: string | null;
}): Promise<ActionResult> {
  const uniq = Array.from(new Set(input.ids.map((x) => x.trim()).filter(Boolean)));
  if (uniq.length === 0) return { error: "请选择要修改的数据" };

  const patch: Record<string, unknown> = {};
  if (input.type) patch.type = input.type;
  if (input.dirId !== undefined) patch.dirId = input.dirId;

  // 若同时传 type + dirId：确保目录类型匹配
  if (input.type && input.dirId) {
    const dir = await prisma.testDesignDir.findUnique({
      where: { id: input.dirId },
      select: { id: true, type: true },
    });
    if (!dir) return { error: "目标目录不存在或已删除" };
    if (dir.type !== input.type) return { error: "目标目录不属于所选类别" };
  }

  if (Object.keys(patch).length === 0) return { error: "未选择任何要修改的字段" };

  await prisma.testDesign.updateMany({
    where: { id: { in: uniq } },
    data: patch,
  });
  revalidatePath("/test-design");
  return { ok: true };
}

export async function bulkImportDesignsToTestCases(input: {
  testDesignIds: string[];
  folderId: string;
}): Promise<ActionResult> {
  const ids = Array.from(
    new Set(input.testDesignIds.map((x) => x.trim()).filter(Boolean)),
  );
  const folderId = input.folderId.trim();
  if (ids.length === 0) return { error: "请选择要导入的设计" };
  if (!folderId) return { error: "请选择用例库目标文件夹" };

  const stripTitleTag = (title: string): string => {
    const m = title.match(/^【[^】]+】\s*(.*)$/);
    return m ? m[1] ?? title : title;
  };

  const loadDesigns = async (): Promise<
    Array<{
      id: string;
      title: string;
      iterationCode: string | null;
      createdBy: string | null;
      description: string | null;
      precondition: string | null;
      operationSteps: string | null;
      expectedResult: string | null;
      remark: string | null;
    }>
  > => {
    try {
      const rows = await prisma.testDesign.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          iterationCode: true,
          createdBy: true,
          description: true,
          precondition: true,
          operationSteps: true,
          expectedResult: true,
          remark: true,
        } as unknown as Record<string, boolean>,
      });
      const typed = rows as unknown as Array<{
        id: string;
        title: string;
        iterationCode?: string | null;
        createdBy?: string | null;
        description?: string | null;
        precondition?: string | null;
        operationSteps?: string | null;
        expectedResult?: string | null;
        remark?: string | null;
      }>;
      return typed.map((r) => ({
        id: r.id,
        title: r.title,
        iterationCode: r.iterationCode ?? null,
        createdBy: r.createdBy ?? null,
        description: r.description ?? null,
        precondition: r.precondition ?? null,
        operationSteps: r.operationSteps ?? null,
        expectedResult: r.expectedResult ?? null,
        remark: r.remark ?? null,
      }));
    } catch {
      const rows = await prisma.testDesign.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          iterationCode: true,
          description: true,
        } as unknown as Record<string, boolean>,
      });
      const typed = rows as unknown as Array<{
        id: string;
        title: string;
        iterationCode?: string | null;
        description?: string | null;
      }>;
      return typed.map((r) => {
        const unpacked = unpackBodyFromDescription(r.description ?? null);
        return {
          id: r.id,
          title: r.title,
          iterationCode: r.iterationCode ?? null,
          createdBy: null,
          description: unpacked.baseDescription,
          precondition: unpacked.body.precondition,
          operationSteps: unpacked.body.operationSteps,
          expectedResult: unpacked.body.expectedResult,
          remark: unpacked.body.remark,
        };
      });
    }
  };

  const designs = await loadDesigns();
  for (const d of designs) {
    await prisma.$transaction(async (tx) => {
      const tempCaseNo = `__pending_${randomUUID()}`;
      const row = await tx.testCase.create({
        data: {
          caseNo: tempCaseNo,
          title: stripTitleTag(d.title),
          folderId,
          iterationCode: d.iterationCode ?? null,
          submitter: d.createdBy ?? null,
          precondition: d.precondition ?? null,
          operationSteps: d.operationSteps ?? null,
          caseActualResult: d.expectedResult ?? null,
          caseRemark: d.remark ?? null,
        },
        select: { id: true },
      });
      await tx.testCase.update({
        where: { id: row.id },
        data: { caseNo: row.id },
      });
      await tx.testDesignTestCase.create({
        data: { testDesignId: d.id, testCaseId: row.id },
      });
      await tx.testDesignOpLog.create({
        data: {
          testDesignId: d.id,
          action: "IMPORT_TO_TEST_CASE",
          detail: `导入到用例库，生成用例编号 ${row.id}`,
        },
      });
      await tx.testCaseOpLog.create({
        data: {
          testCaseId: row.id,
          action: "CREATE_FROM_DESIGN",
          detail: `由测试设计节点导入创建，设计 ID：${d.id}`,
        },
      });
    });
  }
  revalidatePath("/test-cases");
  revalidatePath("/test-design");
  return { ok: true };
}

export async function createTestDesignNode(input: {
  requirementId: string;
  parentId: string | null;
  title: string;
  type: TestDesignType;
  iterationCode: string; // "" 表示 baseline 模板
  dirId?: string | null;
  createdBy?: string | null;
}): Promise<ActionResult> {
  const title = input.title.trim();
  if (!title) return { error: "节点标题不能为空" };
  if (!input.requirementId) return { error: "请选择需求" };

  const maxSort = await prisma.testDesign.aggregate({
    where: {
      requirementId: input.requirementId,
      parentId: input.parentId,
    },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxSort._max.sortOrder ?? 0) + 1;

  const req = await prisma.requirement.findUnique({
    where: { id: input.requirementId },
    include: { iteration: true },
  });
  if (!req) return { error: "需求不存在" };

  const createdBy = (input.createdBy ?? null)?.toString().trim() || null;
  try {
    await prisma.testDesign.create({
      data: {
        requirementId: input.requirementId,
        parentId: input.parentId,
        title,
        type: input.type,
        sortOrder,
        iterationCode: req.iteration.code,
        dirId: input.dirId ?? null,
        ...(createdBy ? ({ createdBy } as unknown as Record<string, unknown>) : {}),
        ...(createdBy
          ? ({ updatedBy: createdBy } as unknown as Record<string, unknown>)
          : {}),
      },
      select: { id: true },
    });
  } catch (e) {
    if (isUnknownField(e, "createdBy") || isUnknownField(e, "updatedBy")) {
      await prisma.testDesign.create({
        data: {
          requirementId: input.requirementId,
          parentId: input.parentId,
          title,
          type: input.type,
          sortOrder,
          iterationCode: req.iteration.code,
          dirId: input.dirId ?? null,
        },
        select: { id: true },
      });
    } else {
      throw e;
    }
  }
  revalidatePath("/test-design");
  return { ok: true };
}

export type TestDesignDirFlat = {
  id: string;
  name: string;
  type: TestDesignType;
  parentId: string | null;
  sortOrder: number;
};

export async function listTestDesignDirs(input: {
  iterationCode: string;
}): Promise<{ rows?: TestDesignDirFlat[]; error?: string }> {
  const code = input.iterationCode.trim();
  if (!code) return { rows: [] };
  try {
    const it = await prisma.iteration.findUnique({
      where: { code },
      select: { id: true },
    });
    if (!it) return { rows: [] };
    const rows = await prisma.testDesignDir.findMany({
      where: { iterationId: it.id },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true, parentId: true, sortOrder: true },
    });
    return { rows: rows.map((r) => ({ ...r, parentId: r.parentId ?? null })) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "加载目录失败" };
  }
}

export async function createTestDesignDir(input: {
  iterationCode: string;
  type: TestDesignType;
  parentId: string | null;
  name: string;
}): Promise<ActionResult & { id?: string }> {
  const code = input.iterationCode.trim();
  const name = input.name.trim();
  if (!code) return { error: "请选择具体迭代（baseline 不支持维护目录）。" };
  if (!name) return { error: "目录名称不能为空" };
  const it = await prisma.iteration.findUnique({ where: { code }, select: { id: true } });
  if (!it) return { error: "迭代不存在" };
  const max = await prisma.testDesignDir.aggregate({
    where: { iterationId: it.id, parentId: input.parentId, type: input.type },
    _max: { sortOrder: true },
  });
  const sortOrder = (max._max.sortOrder ?? 0) + 1;
  try {
    const row = await prisma.testDesignDir.create({
      data: {
        iterationId: it.id,
        type: input.type,
        parentId: input.parentId,
        name,
        sortOrder,
      },
      select: { id: true },
    });
    revalidatePath("/test-design");
    return { ok: true, id: row.id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "创建目录失败" };
  }
}

export async function renameTestDesignDir(input: {
  id: string;
  name: string;
}): Promise<ActionResult> {
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id) return { error: "无效目录" };
  if (!name) return { error: "目录名称不能为空" };
  try {
    await prisma.testDesignDir.update({ where: { id }, data: { name }, select: { id: true } });
    revalidatePath("/test-design");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "重命名失败" };
  }
}

export async function deleteTestDesignDir(idRaw: string): Promise<ActionResult> {
  const id = idRaw.trim();
  if (!id) return { error: "无效目录" };
  const child = await prisma.testDesignDir.findFirst({ where: { parentId: id }, select: { id: true } });
  if (child) return { error: "该目录下仍有子节点，无法删除。" };
  const used = await prisma.testDesign.findFirst({ where: { dirId: id }, select: { id: true } });
  if (used) return { error: "该目录下仍有关联的测试设计，无法删除。" };
  try {
    await prisma.testDesignDir.delete({ where: { id }, select: { id: true } });
    revalidatePath("/test-design");
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "删除失败" };
  }
}

export async function moveTestDesignDir(input: {
  id: string;
  iterationCode: string;
  targetType: TestDesignType;
  targetParentId: string | null;
}): Promise<ActionResult> {
  const id = input.id.trim();
  const code = input.iterationCode.trim();
  if (!id) return { error: "无效目录" };
  if (!code) return { error: "请选择具体迭代（baseline 不支持维护目录）。" };

  const it = await prisma.iteration.findUnique({ where: { code }, select: { id: true } });
  if (!it) return { error: "迭代不存在" };

  const dir = await prisma.testDesignDir.findUnique({ where: { id }, select: { id: true, iterationId: true } });
  if (!dir) return { error: "目录不存在" };
  if (dir.iterationId !== it.id) return { error: "目录不属于当前迭代" };

  if (input.targetParentId) {
    const p = await prisma.testDesignDir.findUnique({
      where: { id: input.targetParentId },
      select: { id: true, iterationId: true },
    });
    if (!p) return { error: "目标父节点不存在" };
    if (p.iterationId !== it.id) return { error: "目标父节点不属于当前迭代" };
  }

  if (input.targetParentId && input.targetParentId === id) {
    return { error: "不能移动到自身之下" };
  }

  // 防止拖拽把节点挂到自己的后代下
  if (input.targetParentId) {
    const all = await prisma.testDesignDir.findMany({
      where: { iterationId: it.id },
      select: { id: true, parentId: true },
    });
    const byId = new Map(all.map((r) => [r.id, r.parentId ?? null] as const));
    let cur: string | null = input.targetParentId;
    while (cur) {
      if (cur === id) return { error: "不能移动到自己的子树下" };
      cur = byId.get(cur) ?? null;
    }
  }

  const max = await prisma.testDesignDir.aggregate({
    where: { iterationId: it.id, type: input.targetType, parentId: input.targetParentId },
    _max: { sortOrder: true },
  });
  const nextSort = (max._max.sortOrder ?? 0) + 1;

  await prisma.$transaction(async (tx) => {
    // 取出子树 id，用于跨类型移动时同步更新子树 type
    const all = await tx.testDesignDir.findMany({
      where: { iterationId: it.id },
      select: { id: true, parentId: true },
    });
    const children = new Map<string | null, string[]>();
    for (const r of all) {
      const k = r.parentId ?? null;
      const arr = children.get(k) ?? [];
      arr.push(r.id);
      children.set(k, arr);
    }
    const sub: string[] = [];
    const dfs = (nid: string) => {
      sub.push(nid);
      for (const cid of children.get(nid) ?? []) dfs(cid);
    };
    dfs(id);

    await tx.testDesignDir.update({
      where: { id },
      data: {
        type: input.targetType,
        parentId: input.targetParentId,
        sortOrder: nextSort,
      },
      select: { id: true },
    });
    // 若跨类型移动：同步更新整个子树 type，保证同一子树不混类型
    await tx.testDesignDir.updateMany({
      where: { id: { in: sub } },
      data: { type: input.targetType },
    });
  });

  revalidatePath("/test-design");
  return { ok: true };
}

export async function deleteTestDesignNode(nodeId: string): Promise<ActionResult> {
  const id = nodeId.trim();
  if (!id) return { error: "无效节点" };
  try {
    await prisma.$transaction(async (tx) => {
      const toDelete = await collectTestDesignSubtreeIds([id], tx);
      if (toDelete.length === 0) return;
      const rows = await tx.testDesign.findMany({
        where: { id: { in: toDelete } },
        include: { linkedTestCases: { select: { testCaseId: true } } },
      });
      await insertTestDesignDeletedMany(tx, rows);
      await tx.testDesign.deleteMany({ where: { id: { in: toDelete } } });
    });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "删除失败" };
  }
  revalidatePath("/test-design");
  return { ok: true };
}

export async function getTestDesignNodeDetail(nodeId: string) {
  const node = await prisma.testDesign.findUnique({
    where: { id: nodeId },
    include: {
      requirement: {
        include: {
          iteration: { include: { product: true } },
        },
      },
    },
  });
  if (!node) return null;
  const rec = node as unknown as Record<string, unknown>;
  const hasBodyCols =
    "precondition" in rec ||
    "operationSteps" in rec ||
    "expectedResult" in rec ||
    "remark" in rec;
  if (hasBodyCols) return node;
  // 兼容：没有新列时，从 description 里反解
  const { baseDescription, body } = unpackBodyFromDescription(node.description ?? null);
  return {
    ...node,
    description: baseDescription,
    precondition: body.precondition,
    operationSteps: body.operationSteps,
    expectedResult: body.expectedResult,
    remark: body.remark,
  } as unknown as typeof node & DesignBody;
}

function clipDesignField(s: string | null | undefined, max = 100): string {
  const t = (s ?? "").replace(/\r\n/g, "\n").trim();
  if (!t) return "（空）";
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…（共 ${t.length} 字）`;
}

function buildTestDesignBasicSaveDetail(input: {
  prev: {
    title: string;
    description: string | null;
    precondition: string | null;
    operationSteps: string | null;
    expectedResult: string | null;
    remark: string | null;
    type: TestDesignType;
    caseLevel: number | null;
  };
  next: {
    title: string;
    description: string | null;
    precondition: string | null;
    operationSteps: string | null;
    expectedResult: string | null;
    remark: string | null;
    type: TestDesignType;
    caseLevel: number | null;
  };
  updatedBy: string | null;
}): string {
  const { prev, next, updatedBy } = input;
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? "").trim() === (b ?? "").trim();
  const lines: string[] = [];
  if (updatedBy) lines.push(`修改人：${updatedBy}`);
  if (prev.title.trim() !== next.title.trim()) {
    lines.push(`标题：${clipDesignField(prev.title, 80)} → ${clipDesignField(next.title, 80)}`);
  }
  if (!same(prev.description, next.description)) {
    lines.push(
      `描述：${clipDesignField(prev.description, 80)} → ${clipDesignField(next.description, 80)}`,
    );
  }
  if (!same(prev.precondition, next.precondition)) {
    lines.push(
      `前置条件：${clipDesignField(prev.precondition, 80)} → ${clipDesignField(next.precondition, 80)}`,
    );
  }
  if (!same(prev.operationSteps, next.operationSteps)) {
    lines.push(
      `操作步骤：${clipDesignField(prev.operationSteps, 80)} → ${clipDesignField(next.operationSteps, 80)}`,
    );
  }
  if (!same(prev.expectedResult, next.expectedResult)) {
    lines.push(
      `预期结果：${clipDesignField(prev.expectedResult, 80)} → ${clipDesignField(next.expectedResult, 80)}`,
    );
  }
  if (!same(prev.remark, next.remark)) {
    lines.push(
      `备注：${clipDesignField(prev.remark, 80)} → ${clipDesignField(next.remark, 80)}`,
    );
  }
  if (prev.type !== next.type) {
    lines.push(
      `类型：${testDesignTypeLabel[prev.type]} → ${testDesignTypeLabel[next.type]}`,
    );
  }
  const pLv = prev.caseLevel;
  const nLv = next.caseLevel;
  if (pLv !== nLv) {
    lines.push(
      `用例等级：${formatCaseLevelOpLog(pLv)} → ${formatCaseLevelOpLog(nLv)}`,
    );
  }
  const onlyActor = lines.length === 1 && updatedBy;
  if (lines.length === 0 || (onlyActor && lines[0].startsWith("修改人："))) {
    if (updatedBy && lines.length === 0) {
      return `修改人：${updatedBy}\n（各字段与保存前一致）`;
    }
    if (onlyActor) {
      return `${lines[0]}\n（各字段与保存前一致）`;
    }
    return "（各字段与保存前一致）";
  }
  return lines.join("\n");
}

export async function updateTestDesignNode(input: {
  id: string;
  title: string;
  description: string | null;
  precondition: string | null;
  operationSteps: string | null;
  expectedResult: string | null;
  remark: string | null;
  type: TestDesignType;
  caseLevel: number | null;
  updatedBy?: string | null;
}): Promise<ActionResult> {
  const title = input.title.trim();
  if (!title) return { error: "标题不能为空" };
  const updatedBy = (input.updatedBy ?? null)?.toString().trim() || null;

  const prevNode = await getTestDesignNodeDetail(input.id);
  if (!prevNode) return { error: "节点不存在" };
  const caseLevelNorm = parseCaseLevelOrNull(input.caseLevel);
  const prevSnap = {
    title: prevNode.title,
    description: prevNode.description ?? null,
    precondition:
      (prevNode as unknown as { precondition?: string | null }).precondition ??
      null,
    operationSteps:
      (prevNode as unknown as { operationSteps?: string | null })
        .operationSteps ?? null,
    expectedResult:
      (prevNode as unknown as { expectedResult?: string | null })
        .expectedResult ?? null,
    remark: (prevNode as unknown as { remark?: string | null }).remark ?? null,
    type: prevNode.type,
    caseLevel: parseCaseLevelOrNull(
      (prevNode as unknown as { caseLevel?: number | null }).caseLevel,
    ),
  };
  const nextSnap = {
    title,
    description: input.description,
    precondition: input.precondition,
    operationSteps: input.operationSteps,
    expectedResult: input.expectedResult,
    remark: input.remark,
    type: input.type,
    caseLevel: caseLevelNorm,
  };
  const logDetail = buildTestDesignBasicSaveDetail({
    prev: prevSnap,
    next: nextSnap,
    updatedBy,
  });

  try {
    await prisma.testDesign.update({
      where: { id: input.id },
      data: {
        title,
        description: input.description,
        ...(input.precondition !== undefined
          ? ({ precondition: input.precondition } as unknown as Record<
              string,
              unknown
            >)
          : {}),
        ...(input.operationSteps !== undefined
          ? ({ operationSteps: input.operationSteps } as unknown as Record<
              string,
              unknown
            >)
          : {}),
        ...(input.expectedResult !== undefined
          ? ({ expectedResult: input.expectedResult } as unknown as Record<
              string,
              unknown
            >)
          : {}),
        ...(input.remark !== undefined
          ? ({ remark: input.remark } as unknown as Record<string, unknown>)
          : {}),
        type: input.type,
        ...({ caseLevel: caseLevelNorm } as unknown as Record<string, unknown>),
        ...(updatedBy ? ({ updatedBy } as unknown as Record<string, unknown>) : {}),
      },
      select: { id: true },
    });
  } catch (e) {
    if (isUnknownField(e, "caseLevel")) {
      await prisma.testDesign.update({
        where: { id: input.id },
        data: {
          title,
          description: input.description,
          ...(input.precondition !== undefined
            ? ({ precondition: input.precondition } as unknown as Record<
                string,
                unknown
              >)
            : {}),
          ...(input.operationSteps !== undefined
            ? ({ operationSteps: input.operationSteps } as unknown as Record<
                string,
                unknown
              >)
            : {}),
          ...(input.expectedResult !== undefined
            ? ({ expectedResult: input.expectedResult } as unknown as Record<
                string,
                unknown
              >)
            : {}),
          ...(input.remark !== undefined
            ? ({ remark: input.remark } as unknown as Record<string, unknown>)
            : {}),
          type: input.type,
          ...(updatedBy ? ({ updatedBy } as unknown as Record<string, unknown>) : {}),
        },
        select: { id: true },
      });
    } else if (
      isUnknownField(e, "updatedBy") ||
      isUnknownField(e, "precondition") ||
      isUnknownField(e, "operationSteps") ||
      isUnknownField(e, "expectedResult") ||
      isUnknownField(e, "remark")
    ) {
      const packed = packDescriptionWithBody(input.description, {
        precondition: input.precondition,
        operationSteps: input.operationSteps,
        expectedResult: input.expectedResult,
        remark: input.remark,
      });
      await prisma.testDesign.update({
        where: { id: input.id },
        data: {
          title,
          description: packed,
          type: input.type,
        },
        select: { id: true },
      });
    } else {
      throw e;
    }
  }
  revalidatePath("/test-design");
  revalidatePath(`/test-design/node/${input.id}`);
  try {
    await prisma.testDesignOpLog.create({
      data: {
        testDesignId: input.id,
        action: "SAVE_BASIC",
        detail: logDetail,
      },
    });
  } catch {
    /* 未迁移或表不存在时忽略 */
  }
  return { ok: true };
}

export type TestDesignOpLogRow = {
  id: string;
  action: string;
  detail: string | null;
  createdAt: string;
};

export async function getTestDesignOpLogs(
  testDesignId: string,
  take = 12,
): Promise<TestDesignOpLogRow[]> {
  try {
    const rows = await prisma.testDesignOpLog.findMany({
      where: { testDesignId },
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

export async function listTestCasesForPicker(limit = 500) {
  return prisma.testCase.findMany({
    take: limit,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      caseNo: true,
      title: true,
      folder: { select: { name: true } },
    },
  });
}

export async function getLinkedTestCaseIds(testDesignId: string) {
  const rows = await prisma.testDesignTestCase.findMany({
    where: { testDesignId },
    select: { testCaseId: true },
  });
  return rows.map((r) => r.testCaseId);
}

async function formatTestCaseLinesForLog(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.testCase.findMany({
    where: { id: { in: ids } },
    select: { id: true, caseNo: true, title: true },
  });
  const map = new Map(rows.map((r) => [r.id, `${r.caseNo} — ${r.title}`] as const));
  return ids.map((id) => map.get(id) ?? id);
}

export async function setTestDesignLinkedCases(
  testDesignId: string,
  testCaseIds: string[],
): Promise<ActionResult> {
  const unique = [...new Set(testCaseIds.filter(Boolean))];
  const prevRows = await prisma.testDesignTestCase.findMany({
    where: { testDesignId },
    select: { testCaseId: true },
  });
  const prevSet = new Set(prevRows.map((r) => r.testCaseId));
  const nextSet = new Set(unique);
  const added = unique.filter((id) => !prevSet.has(id));
  const removed = [...prevSet].filter((id) => !nextSet.has(id));

  await prisma.$transaction([
    prisma.testDesignTestCase.deleteMany({ where: { testDesignId } }),
    prisma.testDesignTestCase.createMany({
      data: unique.map((testCaseId) => ({ testDesignId, testCaseId })),
    }),
  ]);
  revalidatePath(`/test-design/node/${testDesignId}`);
  revalidatePath("/test-design");

  const addedLines = await formatTestCaseLinesForLog(added);
  const removedLines = await formatTestCaseLinesForLog(removed);
  const parts: string[] = [];
  parts.push(`保存后共关联 ${unique.length} 条用例。`);
  if (added.length > 0) {
    parts.push(`新增 ${added.length} 条：`, ...addedLines);
  }
  if (removed.length > 0) {
    parts.push(`移除 ${removed.length} 条：`, ...removedLines);
  }
  if (added.length === 0 && removed.length === 0) {
    parts.push("（与保存前相比无增删）");
  }
  const linkDetail = parts.join("\n");

  try {
    await prisma.testDesignOpLog.create({
      data: {
        testDesignId,
        action: "SAVE_LINKS",
        detail: linkDetail,
      },
    });
  } catch {
    /* 未迁移或表不存在时忽略 */
  }
  return { ok: true };
}
