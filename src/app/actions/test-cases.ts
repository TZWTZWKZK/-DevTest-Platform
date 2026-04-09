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

export type ActionResult = { ok?: true; error?: string };

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

export async function listFoldersFlat(): Promise<TestCaseFolderFlat[]> {
  let folders = await prisma.testCaseFolder.findMany({
    orderBy: [{ parentId: "asc" }, { sortOrder: "asc" }],
    select: { id: true, name: true, parentId: true, sortOrder: true },
  });
  if (folders.length === 0) {
    const root = await prisma.testCaseFolder.create({
      data: { name: "根目录", parentId: null, sortOrder: 0 },
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
): Promise<Record<string, number>> {
  const flat = await listFoldersFlat();
  const where: Prisma.TestCaseWhereInput = iterationCode
    ? { iterationCode }
    : {};

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
    const pid = f.parentId;
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    childrenByParent.get(pid)!.push(f.id);
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
}): Promise<ActionResult & { id?: string }> {
  const name = input.name.trim();
  if (!name) return { error: "文件夹名称不能为空" };
  const maxSort = await prisma.testCaseFolder.aggregate({
    where: { parentId: input.parentId },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxSort._max.sortOrder ?? 0) + 1;
  try {
    const row = await prisma.testCaseFolder.create({
      data: { name, parentId: input.parentId, sortOrder },
    });
    revalidatePath("/test-cases");
    return { ok: true, id: row.id };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function deleteFolder(folderId: string): Promise<ActionResult> {
  const id = folderId.trim();
  if (!id) return { error: "缺少文件夹 id。" };
  try {
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
): Promise<ActionResult> {
  const n = name.trim();
  if (!n) return { error: "文件夹名称不能为空" };
  try {
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

export async function listTestCaseIdOptions(): Promise<TestCaseIdOption[]> {
  const db = prisma as unknown as {
    testCase: { findMany: (args: unknown) => Promise<unknown[]> };
  };
  const rows = (await db.testCase.findMany({
    orderBy: [{ updatedAt: "desc" }],
    select: { id: true, caseNo: true, title: true },
    take: 800,
  })) as unknown as Array<{ id: string; caseNo: string; title: string }>;
  return rows;
}

export async function searchTestCaseIdOptions(input: {
  q?: string | null;
  iterationCode?: string | null;
  take?: number | null;
}): Promise<TestCaseIdOption[]> {
  const q = (input.q ?? "").trim();
  const iterationCode = (input.iterationCode ?? "").trim();
  const take = Math.max(1, Math.min(200, Number(input.take ?? 20) || 20));

  try {
    const rows = await prisma.testCase.findMany({
      where: {
        ...(iterationCode ? { iterationCode } : {}),
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
): Promise<TestCaseListItem[]> {
  const flat = await listFoldersFlat();
  const scopeIds = collectDescendantFolderIds(flat, viewFolderId);
  const whereBase = {
    folderId: { in: scopeIds },
    ...(iterationCode ? { iterationCode } : {}),
  } as const;

  // 兼容：如果历史数据里还存在旧状态值，先归一化到当前枚举
  try {
    await prisma.$executeRawUnsafe(
      "UPDATE TestCase SET status = 'BLOCKED' WHERE status NOT IN ('PASSED','FAILED','BLOCKED','DEPRECATED')",
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
        "UPDATE TestCase SET status = 'BLOCKED' WHERE status NOT IN ('PASSED','FAILED','BLOCKED','DEPRECATED')",
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
        const flat = await listFoldersFlat();
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
    await prisma.testCase.delete({ where: { id } });
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
    await prisma.testCase.deleteMany({ where: { id: { in: uniq } } });
    revalidatePath("/test-cases");
    return { ok: true };
  } catch (e) {
    return { error: toUserActionError(e) };
  }
}

export async function bulkMoveTestCases(
  ids: string[],
  targetFolderId: string,
): Promise<ActionResult> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return { error: "请先在列表中勾选用例" };
  if (!targetFolderId) return { error: "请选择目标文件夹" };
  try {
    const folder = await prisma.testCaseFolder.findUnique({
      where: { id: targetFolderId },
      select: { id: true },
    });
    if (!folder) return { error: "目标文件夹不存在" };
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
): Promise<ActionResult & { rows?: TestCaseExportRow[] }> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return { error: "请先在列表中勾选要导出的用例" };
  try {
    const flat = await listFoldersFlat();
    const list = await prisma.testCase.findMany({
      where: { id: { in: uniq } },
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
