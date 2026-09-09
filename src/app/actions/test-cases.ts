"use server";

import { randomUUID } from "node:crypto";
import type { TestCaseStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  addDefectLinkedTestCases,
  removeDefectLinkedTestCases,
} from "@/app/actions/defects";
import {
  formatCaseLevelDisplay,
  formatCaseLevelOpLog,
  parseCaseLevelOrNull,
} from "@/lib/case-level";
import {
  collectDescendantFolderIds,
  folderPathFromFlat,
} from "@/lib/folder-path";
import { testCaseStatusLabel } from "@/lib/test-labels";
import { prisma } from "@/lib/prisma";

/** 历史目录无 productId 时归并到 Baseline 产品（若有），否则最早创建的产品 */
export async function migrateLegacyTestCaseFolderProductIds(): Promise<void> {
  try {
    const orphanCount = await prisma.testCaseFolder.count({
      where: { productId: null },
    });
    if (orphanCount === 0) return;
    const baseline = await prisma.product.findFirst({
      where: { isBaseline: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    const first =
      baseline ??
      (await prisma.product.findFirst({
        orderBy: { createdAt: "asc" },
        select: { id: true },
      }));
    if (!first) return;
    await prisma.testCaseFolder.updateMany({
      where: { productId: null },
      data: { productId: first.id },
    });
  } catch {
    /* Client 未 regenerate 等 */
  }
}

/**
 * 解析「用例库」实际归属的产品 id：
 * 若存在标记为 Baseline 的产品，则所有产品在用例库侧统一使用该产品的目录与用例；
 * 否则沿用界面所选 productId（按产品隔离）。
 */
export async function resolveTestCaseLibraryProductId(
  selectedProductId: string,
): Promise<string> {
  const trimmed = selectedProductId.trim();
  try {
    await migrateLegacyTestCaseFolderProductIds();
    const baseline = await prisma.product.findFirst({
      where: { isBaseline: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (baseline) return baseline.id;
  } catch {
    /* ignore */
  }
  return trimmed;
}

export type ActionResult = { ok?: true; error?: string };

type TestCaseWithLinks = Prisma.TestCaseGetPayload<{
  include: {
    testDesignLinks: { select: { testDesignId: true } };
    defectLinks: { select: { defectId: true } };
    executionTaskLinks: { select: { executionTaskId: true } };
  };
}>;

async function insertTestCaseDeletedMany(
  tx: Prisma.TransactionClient,
  rows: TestCaseWithLinks[],
): Promise<void> {
  if (rows.length === 0) return;
  const deletedAt = new Date();
  const db = tx as unknown as {
    testCaseDeleted: { createMany: (args: unknown) => Promise<unknown> };
  };
  await db.testCaseDeleted.createMany({
    data: rows.map((r) => ({
      originalId: r.id,
      caseNo: r.caseNo,
      title: r.title,
      testPlan: r.testPlan,
      iterationCode: r.iterationCode,
      folderId: r.folderId,
      priority: r.priority,
      maintainer: r.maintainer,
      status: r.status,
      precondition: r.precondition,
      operationSteps: r.operationSteps,
      caseActualResult: r.caseActualResult,
      caseRemark: r.caseRemark,
      submitter: r.submitter,
      submittedAt: r.submittedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deletedAt,
      linkedTestDesignIds: r.testDesignLinks.map((x) => x.testDesignId),
      linkedDefectIds: r.defectLinks.map((x) => x.defectId),
      linkedExecTaskIds: r.executionTaskLinks.map((x) => x.executionTaskId),
    })),
  });
}

/** 删除整条用例前：将该用例下执行记录写入误删归档（与单条删除逻辑一致） */
async function archiveExecRecordsBeforeCaseDelete(
  tx: Prisma.TransactionClient,
  testCaseIds: string[],
): Promise<void> {
  const ids = [...new Set(testCaseIds.filter(Boolean))];
  if (ids.length === 0) return;
  const records = await tx.executionTaskTestCaseExecRecord.findMany({
    where: { testCaseId: { in: ids } },
    select: {
      id: true,
      executionTaskId: true,
      testCaseId: true,
      executedAt: true,
      status: true,
      executor: true,
      result: true,
      images: true,
      note: true,
    },
  });
  if (records.length === 0) return;
  await tx.executionTaskTestCaseExecRecordDeleted.createMany({
    data: records.map((r) => ({
      originalId: r.id,
      executionTaskId: r.executionTaskId,
      testCaseId: r.testCaseId,
      executedAt: r.executedAt,
      status: r.status,
      executor: r.executor,
      result: r.result,
      images:
        r.images === null || r.images === undefined
          ? Prisma.JsonNull
          : (r.images as Prisma.InputJsonValue),
      note: r.note,
    })),
  });
}

/** 删除整条用例前：将该用例下操作记录写入误删归档 */
async function archiveOpLogsBeforeCaseDelete(
  tx: Prisma.TransactionClient,
  testCaseIds: string[],
): Promise<void> {
  const ids = [...new Set(testCaseIds.filter(Boolean))];
  if (ids.length === 0) return;
  const logs = await tx.testCaseOpLog.findMany({
    where: { testCaseId: { in: ids } },
    select: {
      id: true,
      testCaseId: true,
      action: true,
      detail: true,
      createdAt: true,
    },
  });
  if (logs.length === 0) return;
  await tx.testCaseOpLogDeleted.createMany({
    data: logs.map((row) => ({
      originalId: row.id,
      testCaseId: row.testCaseId,
      action: row.action,
      detail: row.detail,
      createdAt: row.createdAt,
    })),
  });
}

function jsonFieldToStringIds(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export type DeletedTestCaseArchiveRow = {
  id: string;
  originalId: string;
  caseNo: string;
  title: string;
  folderId: string;
  deletedAt: string;
};

/** 从误删归档恢复「删除整条用例」时写入的执行记录（需在 TestCase 已按 originalId 重建之后调用） */
async function restoreArchivedExecRecordsForTestCase(
  tx: Prisma.TransactionClient,
  testCaseId: string,
): Promise<void> {
  const archived = await tx.executionTaskTestCaseExecRecordDeleted.findMany({
    where: { testCaseId },
  });
  for (const arc of archived) {
    const exists = await tx.executionTaskTestCaseExecRecord.findUnique({
      where: { id: arc.originalId },
      select: { id: true },
    });
    if (exists) {
      await tx.executionTaskTestCaseExecRecordDeleted.delete({
        where: { id: arc.id },
      });
      continue;
    }
    try {
      await tx.executionTaskTestCaseExecRecord.create({
        data: {
          id: arc.originalId,
          executionTaskId: arc.executionTaskId,
          testCaseId: arc.testCaseId,
          executedAt: arc.executedAt,
          status: arc.status,
          executor: arc.executor,
          result: arc.result,
          images:
            arc.images === null || arc.images === undefined
              ? Prisma.JsonNull
              : (arc.images as Prisma.InputJsonValue),
          note: arc.note,
        },
      });
      await tx.executionTaskTestCaseExecRecordDeleted.delete({
        where: { id: arc.id },
      });
    } catch {
      /* 执行任务已删除等导致无法还原本条 */
    }
  }
}

/** 从误删归档恢复「删除整条用例」时写入的操作记录 */
async function restoreArchivedOpLogsForTestCase(
  tx: Prisma.TransactionClient,
  testCaseId: string,
): Promise<void> {
  const archived = await tx.testCaseOpLogDeleted.findMany({
    where: { testCaseId },
    orderBy: { createdAt: "asc" },
  });
  for (const arc of archived) {
    const exists = await tx.testCaseOpLog.findUnique({
      where: { id: arc.originalId },
      select: { id: true },
    });
    if (exists) {
      await tx.testCaseOpLogDeleted.delete({ where: { id: arc.id } });
      continue;
    }
    try {
      await tx.testCaseOpLog.create({
        data: {
          id: arc.originalId,
          testCaseId: arc.testCaseId,
          action: arc.action,
          detail: arc.detail,
          createdAt: arc.createdAt,
        },
      });
      await tx.testCaseOpLogDeleted.delete({ where: { id: arc.id } });
    } catch {
      /* 极少冲突 */
    }
  }
}

/** 列出删除归档（默认最多 500 条，按删除时间倒序） */
export async function listDeletedTestCasesArchive(input?: {
  /** 含当日 0 点起（由前端传入本地日起始的 ISO 字符串即可） */
  deletedAfter?: string | null;
}): Promise<{ rows: DeletedTestCaseArchiveRow[]; error?: string }> {
  try {
    const rawAfter = input?.deletedAfter?.trim();
    const after = rawAfter ? new Date(rawAfter) : null;
    const afterOk = after !== null && !Number.isNaN(after.getTime());
    const rows = await prisma.testCaseDeleted.findMany({
      where: afterOk ? { deletedAt: { gte: after! } } : undefined,
      orderBy: { deletedAt: "desc" },
      take: 500,
      select: {
        id: true,
        originalId: true,
        caseNo: true,
        title: true,
        folderId: true,
        deletedAt: true,
      },
    });
    return {
      rows: rows.map((r) => ({
        ...r,
        deletedAt: r.deletedAt.toISOString(),
      })),
    };
  } catch (e) {
    return { rows: [], error: toUserActionError(e) };
  }
}

/** 从 TestCaseDeleted 恢复用例并删除归档行；关联按归档 JSON 尽力重建（目标不存在则跳过） */
export async function restoreTestCasesFromArchive(
  archiveIds: string[],
  options?: {
    /** 归档中的 folderId 已不存在时，改用此目录（须存在） */
    folderIdIfMissing?: string | null;
  },
): Promise<ActionResult & { restored?: number; notes?: string[] }> {
  const uniq = [...new Set(archiveIds.map((x) => x.trim()).filter(Boolean))];
  if (uniq.length === 0) return { error: "请选择要恢复的归档条目。" };

  const fallbackFolderInput = options?.folderIdIfMissing?.trim() ?? "";

  const notes: string[] = [];
  let restored = 0;

  for (const archiveId of uniq) {
    try {
      await prisma.$transaction(async (tx) => {
        const row = await tx.testCaseDeleted.findUnique({
          where: { id: archiveId },
        });
        if (!row) {
          notes.push(`归档 id ${archiveId.slice(0, 8)}… 不存在或已恢复`);
          throw new Error("__abort_tx");
        }

        const existsId = await tx.testCase.findUnique({
          where: { id: row.originalId },
          select: { id: true },
        });
        if (existsId) {
          notes.push(`「${row.caseNo}」已在用例库中，跳过`);
          throw new Error("__abort_tx");
        }

        const dupNo = await tx.testCase.findFirst({
          where: { caseNo: row.caseNo },
          select: { id: true },
        });
        if (dupNo) {
          notes.push(`编号「${row.caseNo}」已被占用，无法恢复「${row.title}」`);
          throw new Error("__abort_tx");
        }

        let resolvedFolderId = row.folderId;
        const folderOk = await tx.testCaseFolder.findUnique({
          where: { id: row.folderId },
          select: { id: true },
        });
        if (!folderOk) {
          if (!fallbackFolderInput) {
            notes.push(`「${row.caseNo}」原目录已不存在，请在界面指定替代目录后重试`);
            throw new Error("__abort_tx");
          }
          const fbOk = await tx.testCaseFolder.findUnique({
            where: { id: fallbackFolderInput },
            select: { id: true },
          });
          if (!fbOk) {
            notes.push(`指定的替代目录不存在，无法恢复「${row.caseNo}」`);
            throw new Error("__abort_tx");
          }
          resolvedFolderId = fallbackFolderInput;
        }

        await tx.testCase.create({
          data: {
            id: row.originalId,
            caseNo: row.caseNo,
            title: row.title,
            testPlan: row.testPlan,
            iterationCode: row.iterationCode,
            folderId: resolvedFolderId,
            priority: row.priority,
            maintainer: row.maintainer,
            status: row.status,
            precondition: row.precondition,
            operationSteps: row.operationSteps,
            caseActualResult: row.caseActualResult,
            caseRemark: row.caseRemark,
            submitter: row.submitter,
            submittedAt: row.submittedAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
        });

        for (const testDesignId of jsonFieldToStringIds(row.linkedTestDesignIds)) {
          try {
            await tx.testDesignTestCase.create({
              data: { testDesignId, testCaseId: row.originalId },
            });
          } catch {
            /* 测试设计已删除等 */
          }
        }
        for (const defectId of jsonFieldToStringIds(row.linkedDefectIds)) {
          try {
            await tx.defectTestCase.create({
              data: { defectId, testCaseId: row.originalId },
            });
          } catch {
            /* 缺陷已删除等 */
          }
        }
        for (const executionTaskId of jsonFieldToStringIds(
          row.linkedExecTaskIds,
        )) {
          try {
            await tx.executionTaskTestCase.create({
              data: { executionTaskId, testCaseId: row.originalId },
            });
          } catch {
            /* 执行任务已删除等 */
          }
        }

        await restoreArchivedExecRecordsForTestCase(tx, row.originalId);
        await restoreArchivedOpLogsForTestCase(tx, row.originalId);

        await tx.testCaseDeleted.delete({ where: { id: row.id } });
      });
      restored += 1;
    } catch (e) {
      if (e instanceof Error && e.message === "__abort_tx") continue;
      notes.push(
        `${archiveId.slice(0, 8)}…：${toUserActionError(e)}`,
      );
    }
  }

  if (restored === 0) {
    const hint =
      notes.length > 0
        ? notes.slice(0, 6).join("；") + (notes.length > 6 ? "…" : "")
        : "未恢复任何条目。";
    return { error: hint };
  }

  revalidatePath("/test-cases");
  revalidatePath("/executions");
  return {
    ok: true,
    restored,
    notes: notes.length > 0 ? notes : undefined,
  };
}

const DEFECT_STATUS_ZH: Record<string, string> = {
  UNASSIGNED: "未分配",
  IN_DEVELOPMENT: "开发中",
  TESTING: "测试",
  CLOSED: "已关闭",
  REOPENED: "重开",
};

const DEFECT_SEVERITY_ZH: Record<string, string> = {
  CRITICAL: "致命",
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

function buildDefectLinkOpDetail(
  def: {
    id: string;
    defectNo: string;
    name: string;
    status: string;
    severity: string;
    iterationCode: string | null;
  },
  kind: "LINK_DEFECT" | "UNLINK_DEFECT",
): string {
  const head =
    kind === "LINK_DEFECT" ? "关联缺陷（完整信息）" : "解除关联缺陷（完整信息）";
  const lines = [
    head,
    `缺陷ID：${def.id}`,
    `缺陷编号：${def.defectNo}`,
    `缺陷名称：${def.name}`,
    `状态：${DEFECT_STATUS_ZH[def.status] ?? def.status}`,
    `严重等级：${DEFECT_SEVERITY_ZH[def.severity] ?? def.severity}`,
    `关联迭代：${def.iterationCode?.trim() ? def.iterationCode : "（空）"}`,
  ];
  return lines.join("\n");
}

function clipCaseOpField(s: string | null | undefined, max = 120): string {
  const t = (s ?? "").replace(/\r\n/g, "\n").trim();
  if (!t) return "（空）";
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…（共 ${t.length} 字）`;
}

function sameCaseText(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? "").trim() === (b ?? "").trim();
}

type TestCaseOpSnapshot = {
  caseNo: string;
  title: string;
  testPlan: string | null;
  iterationCode: string | null;
  folderId: string;
  priority: number | null;
  maintainer: string | null;
  status: TestCaseStatus | null;
  precondition: string | null;
  operationSteps: string | null;
  caseActualResult: string | null;
  caseRemark: string | null;
  submitter: string | null;
};

function folderPathShort(
  flat: { id: string; name: string; parentId: string | null }[],
  folderId: string,
): string {
  try {
    return folderPathFromFlat(folderId, flat) || folderId;
  } catch {
    return folderId;
  }
}

function buildTestCaseCreateOpDetail(
  flat: { id: string; name: string; parentId: string | null }[],
  displayCaseNo: string,
  snap: TestCaseOpSnapshot,
): string {
  const lines = [
    "新建用例（初值）",
    `用例编号：${displayCaseNo}`,
    `用例名称：${snap.title}`,
    `测试计划：${clipCaseOpField(snap.testPlan, 200)}`,
    `关联迭代：${snap.iterationCode?.trim() ? snap.iterationCode : "（空）"}`,
    `所在目录：${folderPathShort(flat, snap.folderId)}`,
    `用例等级：${formatCaseLevelOpLog(snap.priority)}`,
    `维护人：${snap.maintainer?.trim() ? snap.maintainer : "（空）"}`,
    `状态：${snap.status ? (testCaseStatusLabel[snap.status] ?? snap.status) : "（空）"}`,
    `前置条件：${clipCaseOpField(snap.precondition, 120)}`,
    `操作步骤：${clipCaseOpField(snap.operationSteps, 120)}`,
    `预期结果：${clipCaseOpField(snap.caseActualResult, 120)}`,
    `备注：${clipCaseOpField(snap.caseRemark, 120)}`,
    `提交人：${snap.submitter?.trim() ? snap.submitter : "（空）"}`,
  ];
  return lines.join("\n");
}

function buildTestCaseUpdateOpDetail(
  flat: { id: string; name: string; parentId: string | null }[],
  prev: TestCaseOpSnapshot,
  next: TestCaseOpSnapshot,
): string {
  const lines: string[] = ["保存基本信息（字段变更）"];
  const pushIf = (label: string, oldV: string, newV: string) => {
    lines.push(`${label}：${oldV} → ${newV}`);
  };
  if (prev.caseNo !== next.caseNo) {
    pushIf("用例编号", prev.caseNo, next.caseNo);
  }
  if (!sameCaseText(prev.title, next.title)) {
    pushIf("用例名称", clipCaseOpField(prev.title, 80), clipCaseOpField(next.title, 80));
  }
  if (!sameCaseText(prev.testPlan, next.testPlan)) {
    pushIf("测试计划", clipCaseOpField(prev.testPlan, 80), clipCaseOpField(next.testPlan, 80));
  }
  if (
    (prev.iterationCode ?? "").trim() !== (next.iterationCode ?? "").trim()
  ) {
    pushIf(
      "关联迭代",
      (prev.iterationCode ?? "").trim() || "（空）",
      (next.iterationCode ?? "").trim() || "（空）",
    );
  }
  if (prev.folderId !== next.folderId) {
    pushIf(
      "所在目录",
      folderPathShort(flat, prev.folderId),
      folderPathShort(flat, next.folderId),
    );
  }
  const pPri = prev.priority;
  const nPri = next.priority;
  if (pPri !== nPri) {
    pushIf(
      "用例等级",
      formatCaseLevelOpLog(pPri),
      formatCaseLevelOpLog(nPri),
    );
  }
  if (!sameCaseText(prev.maintainer, next.maintainer)) {
    pushIf(
      "维护人",
      prev.maintainer?.trim() || "（空）",
      next.maintainer?.trim() || "（空）",
    );
  }
  if (prev.status !== next.status) {
    pushIf(
      "状态",
      prev.status ? (testCaseStatusLabel[prev.status] ?? String(prev.status)) : "（空）",
      next.status ? (testCaseStatusLabel[next.status] ?? String(next.status)) : "（空）",
    );
  }
  if (!sameCaseText(prev.precondition, next.precondition)) {
    pushIf(
      "前置条件",
      clipCaseOpField(prev.precondition, 60),
      clipCaseOpField(next.precondition, 60),
    );
  }
  if (!sameCaseText(prev.operationSteps, next.operationSteps)) {
    pushIf(
      "操作步骤",
      clipCaseOpField(prev.operationSteps, 60),
      clipCaseOpField(next.operationSteps, 60),
    );
  }
  if (!sameCaseText(prev.caseActualResult, next.caseActualResult)) {
    pushIf(
      "预期结果",
      clipCaseOpField(prev.caseActualResult, 60),
      clipCaseOpField(next.caseActualResult, 60),
    );
  }
  if (!sameCaseText(prev.caseRemark, next.caseRemark)) {
    pushIf(
      "备注",
      clipCaseOpField(prev.caseRemark, 60),
      clipCaseOpField(next.caseRemark, 60),
    );
  }
  if (!sameCaseText(prev.submitter, next.submitter)) {
    pushIf(
      "提交人",
      prev.submitter?.trim() || "（空）",
      next.submitter?.trim() || "（空）",
    );
  }
  if (lines.length === 1) {
    return `${lines[0]}\n（各字段与保存前一致）`;
  }
  return lines.join("\n");
}

function snapshotFromPrismaRow(r: {
  caseNo: string;
  title: string;
  testPlan: string | null;
  iterationCode?: string | null;
  folderId: string;
  priority: number | null;
  maintainer: string | null;
  status: TestCaseStatus | null;
  precondition: string | null;
  operationSteps: string | null;
  caseActualResult: string | null;
  caseRemark: string | null;
  submitter: string | null;
}): TestCaseOpSnapshot {
  return {
    caseNo: r.caseNo,
    title: r.title,
    testPlan: r.testPlan,
    iterationCode: r.iterationCode ?? null,
    folderId: r.folderId,
    priority: r.priority,
    maintainer: r.maintainer,
    status: r.status ?? null,
    precondition: r.precondition,
    operationSteps: r.operationSteps,
    caseActualResult: r.caseActualResult,
    caseRemark: r.caseRemark,
    submitter: r.submitter,
  };
}

function prismaKnownToMessage(e: Prisma.PrismaClientKnownRequestError): string {
  switch (e.code) {
    case "P2002":
      return "与已有数据冲突（例如用例编号不能重复）。";
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
  if (e instanceof Error && e.message) {
    return `操作失败：${e.message}`;
  }
  return "操作失败，请稍后重试。";
}

function isUnknownField(e: unknown, field: string): boolean {
  if (!(e instanceof Error)) return false;
  return e.message.includes(`Unknown field \`${field}\``);
}

async function getTestCaseSnapshotRow(
  id: string,
): Promise<TestCaseOpSnapshot | null> {
  try {
    const row = await prisma.testCase.findUnique({
      where: { id },
      select: {
        caseNo: true,
        title: true,
        testPlan: true,
        iterationCode: true,
        folderId: true,
        priority: true,
        maintainer: true,
        status: true,
        precondition: true,
        operationSteps: true,
        caseActualResult: true,
        caseRemark: true,
        submitter: true,
      },
    });
    return row ? snapshotFromPrismaRow(row) : null;
  } catch (e) {
    if (isUnknownField(e, "iterationCode")) {
      const row = await prisma.testCase.findUnique({
        where: { id },
        select: {
          caseNo: true,
          title: true,
          testPlan: true,
          folderId: true,
          priority: true,
          maintainer: true,
          status: true,
          precondition: true,
          operationSteps: true,
          caseActualResult: true,
          caseRemark: true,
          submitter: true,
        },
      });
      return row ? snapshotFromPrismaRow({ ...row, iterationCode: null }) : null;
    }
    throw e;
  }
}

function isInvalidEnumValue(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return (
    e.message.includes("Invalid enum value") ||
    e.message.includes("is not a valid") ||
    e.message.includes("value for enum")
  );
}

export type TestCaseFolderFlat = {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
};

export async function listFoldersFlat(productId: string): Promise<TestCaseFolderFlat[]> {
  const pid = await resolveTestCaseLibraryProductId(productId);
  if (!pid) return [];
  let folders = await prisma.testCaseFolder.findMany({
    where: { productId: pid },
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }],
    select: { id: true, name: true, parentId: true, sortOrder: true },
  });
  if (folders.length === 0) {
    const root = await prisma.testCaseFolder.create({
      data: { name: "根目录", parentId: null, sortOrder: 0, productId: pid },
    });
    folders = [
      {
        id: root.id,
        name: root.name,
        parentId: root.parentId,
        sortOrder: root.sortOrder,
      },
    ];
  }
  return folders;
}

/** 各目录下用例数（含所有子孙目录），与 listTestCasesInFolder 的迭代筛选规则一致 */
export async function countTestCasesByFolderSubtree(
  iterationCode?: string | null,
  productId?: string | null,
): Promise<Record<string, number>> {
  const pid = await resolveTestCaseLibraryProductId((productId ?? "").trim());
  if (!pid) return {};
  const flat = await listFoldersFlat(productId ?? "");
  const where: Prisma.TestCaseWhereInput = {
    ...(iterationCode ? { iterationCode } : {}),
    folder: { productId: pid },
  };

  const groups = await prisma.testCase.groupBy({
    by: ["folderId"],
    where,
    _count: { _all: true },
  });

  const direct = new Map<string, number>();
  for (const g of groups) {
    direct.set(g.folderId, g._count._all);
  }

  const childrenByParent = new Map<string | null, string[]>();
  for (const f of flat) {
    const parentKey = f.parentId;
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey)!.push(f.id);
  }

  const memo = new Map<string, number>();
  function subtree(id: string): number {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    let t = direct.get(id) ?? 0;
    for (const c of childrenByParent.get(id) ?? []) {
      t += subtree(c);
    }
    memo.set(id, t);
    return t;
  }

  const out: Record<string, number> = {};
  for (const f of flat) {
    out[f.id] = subtree(f.id);
  }
  return out;
}

export async function createFolder(input: {
  name: string;
  parentId: string | null;
  productId: string;
}): Promise<ActionResult & { id?: string }> {
  const name = input.name.trim();
  const pidIn = await resolveTestCaseLibraryProductId(input.productId);
  if (!name) return { error: "文件夹名称不能为空" };
  if (!pidIn) return { error: "缺少产品信息，无法创建目录。" };

  const parentId = input.parentId;
  if (parentId) {
    const par = await prisma.testCaseFolder.findUnique({
      where: { id: parentId },
      select: { productId: true },
    });
    if (!par?.productId) return { error: "父目录不存在。" };
    if (par.productId !== pidIn) return { error: "父目录与当前所选产品不一致。" };
  }

  const maxSort = await prisma.testCaseFolder.aggregate({
    where: { parentId, productId: pidIn },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxSort._max.sortOrder ?? 0) + 1;
  try {
    const row = await prisma.testCaseFolder.create({
      data: {
        name,
        parentId,
        sortOrder,
        productId: pidIn,
      },
    });
    revalidatePath("/test-cases");
    return { ok: true, id: row.id };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function deleteFolder(
  folderId: string,
  productId: string,
): Promise<ActionResult> {
  const id = folderId.trim();
  const pid = await resolveTestCaseLibraryProductId(productId);
  if (!id || !pid) return { error: "缺少文件夹或产品信息。" };
  try {
    const row = await prisma.testCaseFolder.findUnique({
      where: { id },
      select: { productId: true },
    });
    if (!row || row.productId !== pid) {
      return { error: "目录不存在或不属于当前产品。" };
    }
    const subCount = await prisma.testCaseFolder.count({
      where: { parentId: id },
    });
    if (subCount > 0) {
      return { error: "该目录下仍有子文件夹，请先删除或移走子文件夹。" };
    }
    const caseCount = await prisma.testCase.count({ where: { folderId: id } });
    if (caseCount > 0) {
      return { error: "该目录下仍有测试用例，请先移走或删除用例后再删目录。" };
    }
    await prisma.testCaseFolder.delete({ where: { id } });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function renameFolder(
  folderId: string,
  name: string,
  productId: string,
): Promise<ActionResult> {
  const n = name.trim();
  const pid = await resolveTestCaseLibraryProductId(productId);
  if (!n) return { error: "文件夹名称不能为空" };
  if (!pid) return { error: "缺少产品信息。" };
  try {
    const row = await prisma.testCaseFolder.findUnique({
      where: { id: folderId },
      select: { productId: true },
    });
    if (!row || row.productId !== pid) {
      return { error: "目录不存在或不属于当前产品。" };
    }
    await prisma.testCaseFolder.update({
      where: { id: folderId },
      data: { name: n },
    });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

/** 在同一父目录下调整文件夹顺序（仅平级，不改变父子关系） */
export async function reorderTestCaseFolderSiblings(input: {
  productId: string;
  parentId: string | null;
  orderedIds: string[];
}): Promise<ActionResult> {
  const libraryPid = await resolveTestCaseLibraryProductId(input.productId);
  if (!libraryPid) return { error: "缺少产品信息。" };

  const ordered = [
    ...new Set(input.orderedIds.map((x) => x.trim()).filter(Boolean)),
  ];
  if (ordered.length === 0) return { error: "顺序无效。" };

  const parentWhere =
    input.parentId === null || input.parentId === ""
      ? { parentId: null }
      : { parentId: input.parentId };

  const existing = await prisma.testCaseFolder.findMany({
    where: {
      productId: libraryPid,
      ...parentWhere,
    },
    select: { id: true },
  });
  if (existing.length !== ordered.length) {
    return { error: "目录列表已变化，请刷新页面后重试。" };
  }
  const setOk = new Set(existing.map((e) => e.id));
  for (const id of ordered) {
    if (!setOk.has(id)) {
      return { error: "目录列表已变化，请刷新页面后重试。" };
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < ordered.length; i++) {
        await tx.testCaseFolder.update({
          where: { id: ordered[i]! },
          data: { sortOrder: i + 1 },
        });
      }
    });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

/** 跨层级移动目录（变更 parentId，插入为新父级下最后一个子目录） */
export async function moveTestCaseFolder(input: {
  folderId: string;
  newParentId: string | null;
  productId: string;
}): Promise<ActionResult> {
  const libraryPid = await resolveTestCaseLibraryProductId(input.productId);
  if (!libraryPid) return { error: "缺少产品信息。" };

  const fid = input.folderId.trim();
  const rawParent = input.newParentId?.trim();
  const newParentId = rawParent ? rawParent : null;
  if (!fid) return { error: "缺少目录标识。" };

  const folder = await prisma.testCaseFolder.findUnique({
    where: { id: fid },
    select: { id: true, productId: true, parentId: true },
  });
  if (!folder || folder.productId !== libraryPid) {
    return { error: "目录不存在或无权操作。" };
  }

  if (newParentId) {
    const par = await prisma.testCaseFolder.findUnique({
      where: { id: newParentId },
      select: { id: true, productId: true },
    });
    if (!par || par.productId !== libraryPid) {
      return { error: "目标父目录不存在。" };
    }
    if (newParentId === fid) {
      return { error: "不能将目录移动到自身之下。" };
    }
  }

  const flat = await listFoldersFlat(input.productId);
  const subtree = collectDescendantFolderIds(flat, fid);
  if (newParentId && subtree.includes(newParentId)) {
    return { error: "不能将目录移动到其子目录下。" };
  }

  const norm = (p: string | null | undefined) => p ?? null;
  if (norm(folder.parentId) === norm(newParentId)) {
    return { ok: true };
  }

  const maxSort = await prisma.testCaseFolder.aggregate({
    where: {
      productId: libraryPid,
      ...(newParentId === null ? { parentId: null } : { parentId: newParentId }),
    },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxSort._max.sortOrder ?? 0) + 1;

  try {
    await prisma.testCaseFolder.update({
      where: { id: fid },
      data: { parentId: newParentId, sortOrder },
    });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export type TestCaseListItem = {
  id: string;
  caseNo: string;
  title: string;
  status: TestCaseStatus | null;
  priority: number | null;
  maintainer: string | null;
  submitter: string | null;
  iterationCode: string | null;
  createdAt: string;
  updatedAt: string;
  folderId: string;
  folderPath: string;
  /** 是否直接归属当前选中的目录（非子目录内） */
  isDirectInSelection: boolean;
};

export type TestCaseIdOption = {
  id: string;
  caseNo: string;
  title: string;
  /** 搜索关联时返回，便于展示 */
  folderName?: string | null;
};

export async function listTestCaseIdOptions(input?: {
  productId?: string | null;
}): Promise<TestCaseIdOption[]> {
  const raw = input?.productId?.trim();
  const pid = raw ? await resolveTestCaseLibraryProductId(raw) : "";
  try {
    await migrateLegacyTestCaseFolderProductIds();
    const rows = await prisma.testCase.findMany({
      where: pid ? { folder: { productId: pid } } : undefined,
      orderBy: [{ updatedAt: "desc" }],
      select: { id: true, caseNo: true, title: true },
      take: 800,
    });
    return rows;
  } catch {
    return [];
  }
}

export async function searchTestCaseIdOptions(input: {
  q?: string | null;
  iterationCode?: string | null;
  take?: number | null;
  /** 按用例库归属产品过滤（与目录树隔离一致） */
  productId?: string | null;
}): Promise<TestCaseIdOption[]> {
  const q = (input.q ?? "").trim();
  const iterationCode = (input.iterationCode ?? "").trim();
  const rawProductId = (input.productId ?? "").trim();
  const productId = rawProductId
    ? await resolveTestCaseLibraryProductId(rawProductId)
    : "";
  const take = Math.max(1, Math.min(200, Number(input.take ?? 20) || 20));

  try {
    await migrateLegacyTestCaseFolderProductIds();
    const rows = await prisma.testCase.findMany({
      where: {
        ...(iterationCode ? { iterationCode } : {}),
        ...(productId ? { folder: { productId } } : {}),
        ...(q
          ? {
              OR: [
                { caseNo: { contains: q } },
                { title: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        caseNo: true,
        title: true,
        folder: { select: { name: true } },
      },
      take,
    });
    return rows.map((r) => ({
      id: r.id,
      caseNo: r.caseNo,
      title: r.title,
      folderName: r.folder?.name ?? null,
    }));
  } catch {
    return [];
  }
}

/** 列出当前目录及其所有子孙目录下的用例，供上级目录一并查看 */
export async function listTestCasesInFolder(
  viewFolderId: string,
  iterationCode?: string | null,
  productId?: string | null,
): Promise<TestCaseListItem[]> {
  const pid = await resolveTestCaseLibraryProductId((productId ?? "").trim());
  if (!pid) return [];
  await migrateLegacyTestCaseFolderProductIds();
  const folderRow = await prisma.testCaseFolder.findUnique({
    where: { id: viewFolderId.trim() },
    select: { id: true, productId: true },
  });
  if (!folderRow || folderRow.productId !== pid) return [];

  const flat = await listFoldersFlat((productId ?? "").trim());
  const scopeIds = collectDescendantFolderIds(flat, viewFolderId);
  const whereBase = {
    folderId: { in: scopeIds },
    folder: { productId: pid },
    ...(iterationCode ? { iterationCode } : {}),
  } as const;

  // 兼容：如果历史数据里还存在旧状态值，先归一化到当前枚举
  try {
    await prisma.$executeRawUnsafe(
      "UPDATE TestCase SET status = 'BLOCKED' WHERE status NOT IN ('PASSED','FAILED','BLOCKED','DEPRECATED','REQ_TRANSFER')",
    );
  } catch {
    // ignore
  }

  let rows: Array<{
    id: string;
    caseNo: string;
    title: string;
    status: TestCaseStatus | null;
    priority: number | null;
    maintainer: string | null;
    submitter: string | null;
    iterationCode?: string | null;
    createdAt: Date;
    updatedAt: Date;
    folderId: string;
  }>;

  try {
    rows = await prisma.testCase.findMany({
      where: whereBase,
      orderBy: [{ folderId: "asc" }, { updatedAt: "desc" }],
      select: {
        id: true,
        caseNo: true,
        title: true,
        status: true,
        priority: true,
        maintainer: true,
        submitter: true,
        iterationCode: true,
        createdAt: true,
        updatedAt: true,
        folderId: true,
      },
    });
  } catch (e) {
    if (isUnknownField(e, "iterationCode")) {
      const whereCompat = whereBase as unknown as Prisma.TestCaseWhereInput;
      rows = await prisma.testCase.findMany({
        where: whereCompat,
        orderBy: [{ folderId: "asc" }, { updatedAt: "desc" }],
        select: {
          id: true,
          caseNo: true,
          title: true,
          status: true,
          priority: true,
          maintainer: true,
          submitter: true,
          createdAt: true,
          updatedAt: true,
          folderId: true,
        } as unknown as Prisma.TestCaseSelect,
      });
    } else if (isInvalidEnumValue(e)) {
      // 再次兜底归一化并重试一次
      await prisma.$executeRawUnsafe(
        "UPDATE TestCase SET status = 'BLOCKED' WHERE status NOT IN ('PASSED','FAILED','BLOCKED','DEPRECATED','REQ_TRANSFER')",
      );
      const whereCompat = whereBase as unknown as Prisma.TestCaseWhereInput;
      rows = await prisma.testCase.findMany({
        where: whereCompat,
        orderBy: [{ folderId: "asc" }, { updatedAt: "desc" }],
        select: {
          id: true,
          caseNo: true,
          title: true,
          status: true,
          priority: true,
          maintainer: true,
          submitter: true,
          iterationCode: true,
          createdAt: true,
          updatedAt: true,
          folderId: true,
        } as unknown as Prisma.TestCaseSelect,
      });
    } else {
      throw e;
    }
  }
  return rows.map((c) => ({
    id: c.id,
    caseNo: c.caseNo,
    title: c.title,
    status: c.status,
    priority: c.priority,
    maintainer: c.maintainer,
    submitter: c.submitter,
    iterationCode:
      "iterationCode" in c
        ? ((c as unknown as { iterationCode?: string | null }).iterationCode ??
          null)
        : null,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    folderId: c.folderId,
    folderPath: folderPathFromFlat(c.folderId, flat),
    isDirectInSelection: c.folderId === viewFolderId,
  }));
}

export type TestCaseSaveInput = {
  id?: string;
  caseNo: string;
  title: string;
  testPlan: string | null;
  iterationCode: string | null;
  folderId: string;
  priority: number | null;
  maintainer: string | null;
  status: TestCaseStatus | null;
  precondition: string | null;
  operationSteps: string | null;
  caseActualResult: string | null;
  caseRemark: string | null;
  submitter: string | null;
};

function snapshotFromSaveInput(
  input: TestCaseSaveInput,
  opts: { title: string; priorityNorm: number | null; displayCaseNo: string },
): TestCaseOpSnapshot {
  return {
    caseNo: opts.displayCaseNo,
    title: opts.title,
    testPlan: input.testPlan,
    iterationCode: input.iterationCode,
    folderId: input.folderId,
    priority: opts.priorityNorm,
    maintainer: input.maintainer,
    status: input.status ?? null,
    precondition: input.precondition,
    operationSteps: input.operationSteps,
    caseActualResult: input.caseActualResult,
    caseRemark: input.caseRemark,
    submitter: input.submitter,
  };
}

export type TestCaseOpLogRow = {
  id: string;
  action: string;
  detail: string | null;
  createdAt: string;
};

export type DefectLinkedToCaseRow = {
  id: string;
  defectNo: string;
  name: string;
  status: string;
};

export async function getTestCaseOpLogs(
  testCaseId: string,
  take = 12,
): Promise<TestCaseOpLogRow[]> {
  try {
    const rows = await prisma.testCaseOpLog.findMany({
      where: { testCaseId },
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

/** 删除单条操作记录：先写入误删归档表 */
export async function deleteTestCaseOpLog(opLogId: string): Promise<ActionResult> {
  const id = opLogId.trim();
  if (!id) return { error: "无效记录" };
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.testCaseOpLog.findUnique({
        where: { id },
        select: {
          id: true,
          testCaseId: true,
          action: true,
          detail: true,
          createdAt: true,
        },
      });
      if (!row) return;
      await tx.testCaseOpLogDeleted.create({
        data: {
          originalId: row.id,
          testCaseId: row.testCaseId,
          action: row.action,
          detail: row.detail,
          createdAt: row.createdAt,
        },
      });
      await tx.testCaseOpLog.delete({ where: { id } });
    });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function listDefectsLinkedToTestCase(
  testCaseId: string,
): Promise<DefectLinkedToCaseRow[]> {
  const links = await prisma.defectTestCase.findMany({
    where: { testCaseId },
    include: {
      defect: {
        select: { id: true, defectNo: true, name: true, status: true },
      },
    },
  });
  return links.map((l) => ({
    id: l.defect.id,
    defectNo: l.defect.defectNo,
    name: l.defect.name,
    status: l.defect.status,
  }));
}

export async function linkDefectToTestCase(
  testCaseId: string,
  defectId: string,
): Promise<ActionResult> {
  const tc = testCaseId.trim();
  const d = defectId.trim();
  if (!tc) return { error: "无效用例" };
  if (!d) return { error: "请选择缺陷" };
  const r = await addDefectLinkedTestCases(d, [tc]);
  if (r.error) return r;
  const wasNew = (r.createdTestCaseIds?.length ?? 0) > 0;
  if (!wasNew) {
    revalidatePath("/test-cases");
    return { ok: true };
  }
  try {
    const def = await prisma.defect.findUnique({
      where: { id: d },
      select: {
        id: true,
        defectNo: true,
        name: true,
        status: true,
        severity: true,
        iterationCode: true,
      },
    });
    const total = await prisma.defectTestCase.count({
      where: { testCaseId: tc },
    });
    const base = def
      ? buildDefectLinkOpDetail(
          {
            id: def.id,
            defectNo: def.defectNo,
            name: def.name,
            status: def.status,
            severity: def.severity,
            iterationCode: def.iterationCode,
          },
          "LINK_DEFECT",
        )
      : `关联缺陷（完整信息）\n缺陷ID：${d}\n（未找到缺陷记录）`;
    const detail = `${base}\n当前已关联缺陷总数：${total}`;
    await prisma.testCaseOpLog.create({
      data: {
        testCaseId: tc,
        action: "LINK_DEFECT",
        detail,
      },
    });
  } catch {
    /* ignore */
  }
  revalidatePath("/test-cases");
  return { ok: true };
}

export async function linkDefectsToTestCaseBatch(
  testCaseId: string,
  defectIds: string[],
): Promise<ActionResult> {
  const tc = testCaseId.trim();
  const uniq = Array.from(
    new Set(defectIds.map((x) => x.trim()).filter(Boolean)),
  );
  if (!tc) return { error: "无效用例" };
  if (uniq.length === 0) return { error: "请选择缺陷" };

  const newDetailBlocks: string[] = [];
  const skippedNos: string[] = [];

  for (const d of uniq) {
    const r = await addDefectLinkedTestCases(d, [tc]);
    if (r.error) return r;
    const wasNew = (r.createdTestCaseIds?.length ?? 0) > 0;
    const def = await prisma.defect.findUnique({
      where: { id: d },
      select: {
        id: true,
        defectNo: true,
        name: true,
        status: true,
        severity: true,
        iterationCode: true,
      },
    });
    if (wasNew) {
      newDetailBlocks.push(
        def
          ? buildDefectLinkOpDetail(
              {
                id: def.id,
                defectNo: def.defectNo,
                name: def.name,
                status: def.status,
                severity: def.severity,
                iterationCode: def.iterationCode,
              },
              "LINK_DEFECT",
            )
          : `关联缺陷（完整信息）\n缺陷ID：${d}\n（未找到缺陷记录）`,
      );
    } else {
      skippedNos.push(def?.defectNo ?? d);
    }
  }

  const total = await prisma.defectTestCase.count({
    where: { testCaseId: tc },
  });

  const parts: string[] = [
    `批量关联缺陷（本次提交 ${uniq.length} 个，新增关联 ${newDetailBlocks.length} 条）`,
    `当前已关联缺陷总数：${total}`,
  ];
  if (newDetailBlocks.length > 0) {
    parts.push("", newDetailBlocks.join("\n\n"));
  }
  if (skippedNos.length > 0) {
    parts.push(
      "",
      `（以下已为关联状态，未重复写入：${skippedNos.join("、")}）`,
    );
  }

  try {
    await prisma.testCaseOpLog.create({
      data: {
        testCaseId: tc,
        action: "LINK_DEFECT",
        detail: parts.join("\n"),
      },
    });
  } catch {
    /* ignore */
  }
  revalidatePath("/test-cases");
  return { ok: true };
}

export async function unlinkDefectFromTestCase(
  testCaseId: string,
  defectId: string,
): Promise<ActionResult> {
  const tc = testCaseId.trim();
  const d = defectId.trim();
  if (!tc) return { error: "无效用例" };
  if (!d) return { error: "无效缺陷" };
  const r = await removeDefectLinkedTestCases(d, [tc]);
  if (r.error) return r;
  if ((r.removedCount ?? 0) === 0) {
    revalidatePath("/test-cases");
    return { ok: true };
  }
  try {
    const def = await prisma.defect.findUnique({
      where: { id: d },
      select: {
        id: true,
        defectNo: true,
        name: true,
        status: true,
        severity: true,
        iterationCode: true,
      },
    });
    const total = await prisma.defectTestCase.count({
      where: { testCaseId: tc },
    });
    const base = def
      ? buildDefectLinkOpDetail(
          {
            id: def.id,
            defectNo: def.defectNo,
            name: def.name,
            status: def.status,
            severity: def.severity,
            iterationCode: def.iterationCode,
          },
          "UNLINK_DEFECT",
        )
      : `解除关联缺陷（完整信息）\n缺陷ID：${d}\n（未找到缺陷记录）`;
    const detail = `${base}\n当前已关联缺陷总数：${total}`;
    await prisma.testCaseOpLog.create({
      data: {
        testCaseId: tc,
        action: "UNLINK_DEFECT",
        detail,
      },
    });
  } catch {
    /* ignore */
  }
  revalidatePath("/test-cases");
  return { ok: true };
}

export async function unlinkDefectsFromTestCaseBatch(
  testCaseId: string,
  defectIds: string[],
): Promise<ActionResult> {
  const tc = testCaseId.trim();
  const uniq = Array.from(
    new Set(defectIds.map((x) => x.trim()).filter(Boolean)),
  );
  if (!tc) return { error: "无效用例" };
  if (uniq.length === 0) return { error: "请选择缺陷" };

  const unlinkedBlocks: string[] = [];
  const skippedNos: string[] = [];

  for (const d of uniq) {
    const r = await removeDefectLinkedTestCases(d, [tc]);
    if (r.error) return r;
    const def = await prisma.defect.findUnique({
      where: { id: d },
      select: {
        id: true,
        defectNo: true,
        name: true,
        status: true,
        severity: true,
        iterationCode: true,
      },
    });
    if ((r.removedCount ?? 0) === 0) {
      skippedNos.push(def?.defectNo ?? d);
      continue;
    }
    unlinkedBlocks.push(
      def
        ? buildDefectLinkOpDetail(
            {
              id: def.id,
              defectNo: def.defectNo,
              name: def.name,
              status: def.status,
              severity: def.severity,
              iterationCode: def.iterationCode,
            },
            "UNLINK_DEFECT",
        )
        : `解除关联缺陷（完整信息）\n缺陷ID：${d}\n（未找到缺陷记录）`,
    );
  }

  const total = await prisma.defectTestCase.count({
    where: { testCaseId: tc },
  });

  const parts: string[] = [
    `批量解除关联缺陷（本次提交 ${uniq.length} 个，实际解除 ${unlinkedBlocks.length} 条）`,
    `当前已关联缺陷总数：${total}`,
  ];
  if (unlinkedBlocks.length > 0) {
    parts.push("", unlinkedBlocks.join("\n\n"));
  }
  if (skippedNos.length > 0) {
    parts.push(
      "",
      `（以下无关联记录或未移除：${skippedNos.join("、")}）`,
    );
  }

  try {
    await prisma.testCaseOpLog.create({
      data: {
        testCaseId: tc,
        action: "UNLINK_DEFECT",
        detail: parts.join("\n"),
      },
    });
  } catch {
    /* ignore */
  }
  revalidatePath("/test-cases");
  return { ok: true };
}

export async function saveTestCase(input: TestCaseSaveInput): Promise<ActionResult> {
  const caseNoTrim = input.caseNo.trim();
  const title = input.title.trim();
  if (!title) return { error: "用例名称不能为空" };
  if (!input.folderId) return { error: "请选择用例库文件夹" };

  const folderProduct = await prisma.testCaseFolder.findUnique({
    where: { id: input.folderId },
    select: { productId: true },
  });
  const folderPid = folderProduct?.productId?.trim();
  if (!folderPid) return { error: "所选目录无效或未归属产品。" };

  const priorityNorm =
    input.priority === null || input.priority === undefined
      ? null
      : parseCaseLevelOrNull(Number(input.priority));

  const iterPatch =
    input.iterationCode !== undefined
      ? ({ iterationCode: input.iterationCode } as unknown as Record<
          string,
          unknown
        >)
      : {};

  const createDataBase = {
    title,
    testPlan: input.testPlan,
    ...iterPatch,
    folderId: input.folderId,
    priority: priorityNorm,
    maintainer: input.maintainer,
    status: input.status,
    precondition: input.precondition,
    operationSteps: input.operationSteps,
    caseActualResult: input.caseActualResult,
    caseRemark: input.caseRemark,
    submitter: input.submitter,
  };

  try {
    let savedId: string | null = null;
    let displayCaseNoForLog = caseNoTrim;
    let prevSnapForUpdate: TestCaseOpSnapshot | null = null;

    if (input.id) {
      if (!caseNoTrim) return { error: "用例编号不能为空" };
      const prev = await getTestCaseSnapshotRow(input.id);
      if (!prev) return { error: "用例不存在" };
      prevSnapForUpdate = prev;
      const dup = await prisma.testCase.findFirst({
        where: { caseNo: caseNoTrim, NOT: { id: input.id } },
        select: { id: true },
      });
      if (dup) return { error: "用例编号已被其他用例使用" };

      await prisma.testCase.update({
        where: { id: input.id },
        data: {
          caseNo: caseNoTrim,
          title,
          testPlan: input.testPlan,
          ...iterPatch,
          folderId: input.folderId,
          priority: priorityNorm,
          maintainer: input.maintainer,
          status: input.status,
          precondition: input.precondition,
          operationSteps: input.operationSteps,
          caseActualResult: input.caseActualResult,
          caseRemark: input.caseRemark,
          submitter: input.submitter,
        },
        select: { id: true },
      });
      savedId = input.id;
    } else if (!caseNoTrim) {
      savedId = await prisma.$transaction(async (tx) => {
        const tempCaseNo = `__pending_${randomUUID()}`;
        const row = await tx.testCase.create({
          data: {
            caseNo: tempCaseNo,
            ...createDataBase,
          },
          select: { id: true },
        });
        await tx.testCase.update({
          where: { id: row.id },
          data: { caseNo: row.id },
        });
        return row.id;
      });
      displayCaseNoForLog = savedId;
    } else {
      const dup = await prisma.testCase.findUnique({
        where: { caseNo: caseNoTrim },
        select: { id: true },
      });
      if (dup) return { error: "用例编号已存在" };

      const created = await prisma.testCase.create({
        data: {
          caseNo: caseNoTrim,
          ...createDataBase,
        },
        select: { id: true },
      });
      savedId = created.id;
    }

    if (savedId) {
      try {
        const flat = await listFoldersFlat(folderPid);
        const snapOpts = {
          title,
          priorityNorm,
          displayCaseNo: displayCaseNoForLog,
        };
        const detail = input.id
          ? buildTestCaseUpdateOpDetail(
              flat,
              prevSnapForUpdate!,
              snapshotFromSaveInput(input, snapOpts),
            )
          : buildTestCaseCreateOpDetail(
              flat,
              snapOpts.displayCaseNo,
              snapshotFromSaveInput(input, snapOpts),
            );
        await prisma.testCaseOpLog.create({
          data: {
            testCaseId: savedId,
            action: input.id ? "SAVE" : "CREATE",
            detail,
          },
        });
      } catch {
        /* 未迁移或表不存在时忽略 */
      }
    }

    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function getTestCaseFull(id: string) {
  /** 显式 select，避免旧版 Client 仍请求已从库中移除的列 */
  try {
    return await prisma.testCase.findUnique({
      where: { id },
      select: {
        id: true,
        caseNo: true,
        title: true,
        testPlan: true,
        iterationCode: true,
        folderId: true,
        priority: true,
        maintainer: true,
        status: true,
        precondition: true,
        operationSteps: true,
        caseActualResult: true,
        caseRemark: true,
        submitter: true,
        createdAt: true,
        updatedAt: true,
        folder: {
          select: { id: true, name: true, parentId: true },
        },
      },
    });
  } catch (e) {
    if (isUnknownField(e, "iterationCode")) {
      return prisma.testCase.findUnique({
        where: { id },
        select: {
          id: true,
          caseNo: true,
          title: true,
          testPlan: true,
          folderId: true,
          priority: true,
          maintainer: true,
          status: true,
          precondition: true,
          operationSteps: true,
          caseActualResult: true,
          caseRemark: true,
          submitter: true,
          createdAt: true,
          updatedAt: true,
          folder: {
            select: { id: true, name: true, parentId: true },
          },
        } as unknown as Prisma.TestCaseSelect,
      });
    }
    throw e;
  }
}

export async function deleteTestCase(id: string): Promise<ActionResult> {
  try {
    await prisma.$transaction(async (tx) => {
      const row = await tx.testCase.findUnique({
        where: { id },
        include: {
          testDesignLinks: { select: { testDesignId: true } },
          defectLinks: { select: { defectId: true } },
          executionTaskLinks: { select: { executionTaskId: true } },
        },
      });
      if (!row) return;
      await insertTestCaseDeletedMany(tx, [row]);
      await archiveExecRecordsBeforeCaseDelete(tx, [id]);
      await archiveOpLogsBeforeCaseDelete(tx, [id]);
      await tx.testCase.delete({ where: { id } });
    });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function bulkDeleteTestCases(ids: string[]): Promise<ActionResult> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return { error: "请先在列表中勾选用例" };
  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.testCase.findMany({
        where: { id: { in: uniq } },
        include: {
          testDesignLinks: { select: { testDesignId: true } },
          defectLinks: { select: { defectId: true } },
          executionTaskLinks: { select: { executionTaskId: true } },
        },
      });
      await insertTestCaseDeletedMany(tx, rows);
      await archiveExecRecordsBeforeCaseDelete(tx, uniq);
      await archiveOpLogsBeforeCaseDelete(tx, uniq);
      await tx.testCase.deleteMany({ where: { id: { in: uniq } } });
    });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function bulkMoveTestCases(
  ids: string[],
  targetFolderId: string,
  productId: string,
): Promise<ActionResult> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return { error: "请先在列表中勾选用例" };
  if (!targetFolderId) return { error: "请选择目标文件夹" };
  const pid = await resolveTestCaseLibraryProductId(productId);
  if (!pid) return { error: "缺少产品信息" };
  try {
    const folder = await prisma.testCaseFolder.findUnique({
      where: { id: targetFolderId },
      select: { id: true, productId: true },
    });
    if (!folder || folder.productId !== pid) {
      return { error: "目标文件夹不存在或不属于当前产品" };
    }
    const caseRows = await prisma.testCase.findMany({
      where: { id: { in: uniq } },
      select: { id: true, folder: { select: { productId: true } } },
    });
    if (caseRows.length !== uniq.length) {
      return { error: "部分用例不存在或已被删除" };
    }
    for (const c of caseRows) {
      if (c.folder.productId !== pid) {
        return { error: "只能移动当前产品用例库内的用例" };
      }
    }
    await prisma.testCase.updateMany({
      where: { id: { in: uniq } },
      data: { folderId: targetFolderId },
    });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

/** 批量更新用例元数据；`updates` 仅包含需要写入的字段，`null` 表示清空该字段 */
export async function bulkUpdateTestCasesMeta(input: {
  ids: string[];
  updates: {
    status?: TestCaseStatus | null;
    priority?: number | null;
    maintainer?: string | null;
    submitter?: string | null;
  };
}): Promise<ActionResult> {
  const uniq = [...new Set(input.ids.filter(Boolean))];
  if (uniq.length === 0) return { error: "请先在列表中勾选用例" };

  const data: Prisma.TestCaseUpdateManyMutationInput = {};
  const { updates } = input;
  if ("status" in updates) data.status = updates.status;
  if ("priority" in updates) {
    data.priority =
      updates.priority === null || updates.priority === undefined
        ? null
        : parseCaseLevelOrNull(updates.priority);
  }
  if ("maintainer" in updates) data.maintainer = updates.maintainer;
  if ("submitter" in updates) data.submitter = updates.submitter;

  if (Object.keys(data).length === 0) {
    return { error: "请至少选择一项要修改的内容" };
  }

  try {
    await prisma.testCase.updateMany({
      where: { id: { in: uniq } },
      data,
    });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export type TestCaseExportRow = {
  caseNo: string;
  title: string;
  folderPath: string;
  statusLabel: string;
  priority: string;
  maintainer: string;
  submitter: string;
  createdAt: string;
  updatedAt: string;
  testPlan: string;
  precondition: string;
  operationSteps: string;
  expectedResult: string;
  remark: string;
};

export async function getTestCasesExportRows(
  ids: string[],
  productId: string,
): Promise<ActionResult & { rows?: TestCaseExportRow[] }> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return { error: "请先在列表中勾选要导出的用例" };
  const pid = await resolveTestCaseLibraryProductId(productId);
  if (!pid) return { error: "缺少产品信息" };
  try {
    const flat = await listFoldersFlat(productId);
    const list = await prisma.testCase.findMany({
      where: { id: { in: uniq }, folder: { productId: pid } },
      select: {
        caseNo: true,
        title: true,
        testPlan: true,
        status: true,
        priority: true,
        maintainer: true,
        submitter: true,
        precondition: true,
        operationSteps: true,
        caseActualResult: true,
        caseRemark: true,
        folderId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (list.length !== uniq.length) {
      return { error: "存在无权导出的用例或数据已变化，请刷新后重试" };
    }
    const rows: TestCaseExportRow[] = list.map((r) => ({
      caseNo: r.caseNo,
      title: r.title,
      folderPath: folderPathFromFlat(r.folderId, flat),
      statusLabel: r.status ? testCaseStatusLabel[r.status] : "",
      priority: formatCaseLevelDisplay(r.priority),
      maintainer: r.maintainer ?? "",
      submitter: r.submitter ?? "",
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      testPlan: r.testPlan ?? "",
      precondition: r.precondition ?? "",
      operationSteps: r.operationSteps ?? "",
      expectedResult: r.caseActualResult ?? "",
      remark: r.caseRemark ?? "",
    }));
    return { ok: true, rows };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}
