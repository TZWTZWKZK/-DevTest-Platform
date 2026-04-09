"use server";

import { Prisma, type TestCaseStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type ActionResult = { ok?: true; error?: string };

export type ExecutionTaskFlat = {
  id: string;
  title: string;
  description: string | null;
  iterationId: string;
  parentId: string | null;
  sortOrder: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  linkedCaseCount: number;
  /** 已导入用例中，最近一条执行记录状态为「通过」的条数 */
  passedCaseCount: number;
};

const UI_PREF_KEY_EXEC_TASK_COLS = "ui.execTask.columns.v1";
const UI_PREF_KEY_EXEC_TASK_IMPORTED_COLS = "ui.execTask.importedCase.columns.v1";

export async function getExecutionTaskListColumnConfig(): Promise<{
  config?: unknown;
  error?: string;
}> {
  try {
    const row = await prisma.uiPreference.findUnique({
      where: { key: UI_PREF_KEY_EXEC_TASK_COLS },
      select: { value: true },
    });
    if (!row?.value) return {};
    return { config: JSON.parse(row.value) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "读取列配置失败" };
  }
}

export async function saveExecutionTaskListColumnConfig(input: {
  config: unknown;
}): Promise<ActionResult> {
  try {
    await prisma.uiPreference.upsert({
      where: { key: UI_PREF_KEY_EXEC_TASK_COLS },
      create: { key: UI_PREF_KEY_EXEC_TASK_COLS, value: JSON.stringify(input.config ?? null) },
      update: { value: JSON.stringify(input.config ?? null) },
      select: { key: true },
    });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "保存列配置失败" };
  }
}

export async function getExecutionImportedCaseColumnConfig(): Promise<{
  config?: unknown;
  error?: string;
}> {
  try {
    const row = await prisma.uiPreference.findUnique({
      where: { key: UI_PREF_KEY_EXEC_TASK_IMPORTED_COLS },
      select: { value: true },
    });
    if (!row?.value) return {};
    return { config: JSON.parse(row.value) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "读取列配置失败" };
  }
}

export async function saveExecutionImportedCaseColumnConfig(input: {
  config: unknown;
}): Promise<ActionResult> {
  try {
    await prisma.uiPreference.upsert({
      where: { key: UI_PREF_KEY_EXEC_TASK_IMPORTED_COLS },
      create: {
        key: UI_PREF_KEY_EXEC_TASK_IMPORTED_COLS,
        value: JSON.stringify(input.config ?? null),
      },
      update: { value: JSON.stringify(input.config ?? null) },
      select: { key: true },
    });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "保存列配置失败" };
  }
}

export async function listExecutionTaskIterations(): Promise<
  Array<{ id: string; label: string; taskCount: number }>
> {
  const rows = await prisma.iteration.findMany({
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      code: true,
      product: { select: { name: true } },
      _count: { select: { executionTasks: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    label: `${r.product.name} · ${r.name}${r.code ? `（${r.code}）` : ""}`,
    taskCount: r._count.executionTasks,
  }));
}

export async function listExecutionTasksFlat(
  iterationId: string,
): Promise<ExecutionTaskFlat[]> {
  const it = iterationId.trim();
  if (!it) return [];
  const rows = await prisma.executionTask.findMany({
    where: { iterationId: it },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      description: true,
      iterationId: true,
      parentId: true,
      sortOrder: true,
      createdBy: true,
      updatedBy: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { linkedCases: true } },
    },
  });
  if (rows.length === 0) return [];

  const taskIds = rows.map((r) => r.id);

  const links = await prisma.executionTaskTestCase.findMany({
    where: { executionTaskId: { in: taskIds } },
    select: { executionTaskId: true, testCaseId: true },
  });

  const records = await prisma.executionTaskTestCaseExecRecord.findMany({
    where: { executionTaskId: { in: taskIds } },
    orderBy: { executedAt: "desc" },
    select: { executionTaskId: true, testCaseId: true, status: true },
  });

  const latestStatusByLink = new Map<string, TestCaseStatus>();
  for (const rec of records) {
    const key = `${rec.executionTaskId}\0${rec.testCaseId}`;
    if (!latestStatusByLink.has(key)) latestStatusByLink.set(key, rec.status);
  }

  const passedByTask = new Map<string, number>();
  for (const tid of taskIds) passedByTask.set(tid, 0);
  for (const link of links) {
    const key = `${link.executionTaskId}\0${link.testCaseId}`;
    if (latestStatusByLink.get(key) === "PASSED") {
      passedByTask.set(
        link.executionTaskId,
        (passedByTask.get(link.executionTaskId) ?? 0) + 1,
      );
    }
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    iterationId: r.iterationId,
    parentId: r.parentId,
    sortOrder: r.sortOrder,
    createdBy: r.createdBy ?? null,
    updatedBy: r.updatedBy ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    linkedCaseCount: r._count.linkedCases,
    passedCaseCount: passedByTask.get(r.id) ?? 0,
  }));
}

/** 批量删除：无子任务、无已导入用例、无执行记录脚本的叶子方可删；否则整批拒绝 */
export async function bulkDeleteExecutionTasks(input: {
  ids: string[];
}): Promise<ActionResult> {
  const idSet = new Set(input.ids.map((x) => x.trim()).filter(Boolean));
  if (idSet.size === 0) return { error: "请选择要删除的任务。" };
  const picked = await prisma.executionTask.findMany({
    where: { id: { in: [...idSet] } },
    select: {
      id: true,
      parentId: true,
      iterationId: true,
      title: true,
      _count: {
        select: { linkedCases: true, execCaseRecords: true },
      },
    },
  });
  if (picked.length === 0) return { error: "未找到任务。" };
  if (picked.length !== idSet.size) {
    return {
      error:
        "部分所选任务不存在或已被删除，请刷新页面后重选。含子任务的条目不可批量删除，需先处理子任务。",
    };
  }
  const iterId = picked[0]!.iterationId;
  if (!picked.every((r) => r.iterationId === iterId)) {
    return { error: "一次仅支持删除同一迭代下的任务。" };
  }

  const allInIter = await prisma.executionTask.findMany({
    where: { iterationId: iterId },
    select: { id: true, parentId: true },
  });
  const parentIdsWithChildren = new Set<string>();
  for (const r of allInIter) {
    if (r.parentId) parentIdsWithChildren.add(r.parentId);
  }

  const blockedChildren = picked.filter((r) => parentIdsWithChildren.has(r.id));
  if (blockedChildren.length > 0) {
    const names = blockedChildren.map((r) => `「${r.title}」`).slice(0, 8);
    const suffix =
      blockedChildren.length > 8
        ? ` …（共 ${blockedChildren.length} 项有子任务）`
        : "";
    return {
      error: `以下任务仍有子任务，请先删除或移走子任务后再删父任务：${names.join("、")}${suffix}`,
    };
  }

  const blockedData = picked.filter(
    (r) => r._count.linkedCases > 0 || r._count.execCaseRecords > 0,
  );
  if (blockedData.length > 0) {
    const names = blockedData.map((r) => `「${r.title}」`).slice(0, 8);
    const suffix =
      blockedData.length > 8
        ? ` …（共 ${blockedData.length} 项含导入用例或执行记录）`
        : "";
    return {
      error: `以下任务仍有关联数据（已导入用例或执行记录），请先移除用例/记录后再删除任务：${names.join("、")}${suffix}`,
    };
  }

  await prisma.$transaction(
    [...idSet].map((id) => prisma.executionTask.delete({ where: { id } })),
  );
  revalidatePath("/executions");
  return { ok: true };
}

/** 批量复制：对每个选中根复制整棵子树到同一迭代（不复制已导入用例） */
export async function bulkDuplicateExecutionTasks(input: {
  iterationId: string;
  ids: string[];
}): Promise<ActionResult> {
  const iterationId = input.iterationId.trim();
  if (!iterationId) return { error: "缺少迭代。" };
  const idSet = new Set(input.ids.map((x) => x.trim()).filter(Boolean));
  if (idSet.size === 0) return { error: "请选择要复制的任务。" };

  const allInIter = await prisma.executionTask.findMany({
    where: { iterationId },
    select: {
      id: true,
      parentId: true,
      title: true,
      description: true,
      sortOrder: true,
    },
  });
  const allIds = new Set(allInIter.map((r) => r.id));
  const rowById = new Map(allInIter.map((r) => [r.id, r]));

  for (const id of idSet) {
    if (!allIds.has(id)) return { error: "存在不属于当前迭代的任务，请刷新后重试。" };
  }

  const childrenBy = new Map<string | null, string[]>();
  for (const r of allInIter) {
    const k = r.parentId ?? null;
    if (!childrenBy.has(k)) childrenBy.set(k, []);
    childrenBy.get(k)!.push(r.id);
  }

  const collectSubtree = (root: string): Set<string> => {
    const S = new Set<string>();
    const walk = (id: string) => {
      S.add(id);
      for (const c of childrenBy.get(id) ?? []) walk(c);
    };
    walk(root);
    return S;
  };

  const depthInS = (id: string, S: Set<string>): number => {
    let d = 0;
    let cur = rowById.get(id)!;
    while (cur.parentId && S.has(cur.parentId)) {
      d++;
      cur = rowById.get(cur.parentId)!;
    }
    return d;
  };

  const roots = [...idSet].filter((id) => {
    const p = rowById.get(id)?.parentId;
    return !p || !idSet.has(p);
  });

  const maxRoot = await prisma.executionTask.aggregate({
    where: { iterationId, parentId: null },
    _max: { sortOrder: true },
  });
  let nextRootOrder = (maxRoot._max.sortOrder ?? 0) + 1;

  for (const root of roots) {
    const S = collectSubtree(root);
    const ordered = [...S].sort((a, b) => depthInS(a, S) - depthInS(b, S));
    const idMap = new Map<string, string>();

    for (const oldId of ordered) {
      const r = rowById.get(oldId)!;
      const oldParent = r.parentId && S.has(r.parentId) ? r.parentId : null;
      const newParentId = oldParent ? idMap.get(oldParent) ?? null : null;
      const isNewRoot = !oldParent;
      let sortOrder = r.sortOrder;
      if (isNewRoot) {
        sortOrder = nextRootOrder;
        nextRootOrder += 1;
      }
      const created = await prisma.executionTask.create({
        data: {
          iterationId,
          parentId: newParentId,
          title: isNewRoot ? `${r.title}（副本）` : r.title,
          description: r.description,
          sortOrder,
          createdBy: "系统",
          updatedBy: "系统",
        },
        select: { id: true },
      });
      idMap.set(oldId, created.id);
    }

    // 复制各节点已导入的用例关联（含任务内执行结果字段）
    const subtreeIds = [...S];
    const links = await prisma.executionTaskTestCase.findMany({
      where: { executionTaskId: { in: subtreeIds } },
      select: {
        executionTaskId: true,
        testCaseId: true,
        executionResult: true,
        executedAt: true,
      },
    });
    if (links.length > 0) {
      await prisma.$transaction(
        links.map((link) =>
          prisma.executionTaskTestCase.create({
            data: {
              executionTaskId: idMap.get(link.executionTaskId)!,
              testCaseId: link.testCaseId,
              executionResult: link.executionResult,
              executedAt: link.executedAt,
            },
          }),
        ),
      );
    }
  }

  revalidatePath("/executions");
  return { ok: true };
}

/** 批量转移：将选中节点及其子树移到目标迭代（跨迭代时子树根的 parent 若不在集合内则升为根） */
export async function bulkMoveExecutionTasksToIteration(input: {
  ids: string[];
  targetIterationId: string;
}): Promise<ActionResult> {
  const target = input.targetIterationId.trim();
  if (!target) return { error: "请选择目标迭代。" };
  const idSet = new Set(input.ids.map((x) => x.trim()).filter(Boolean));
  if (idSet.size === 0) return { error: "请选择要转移的任务。" };

  const picked = await prisma.executionTask.findMany({
    where: { id: { in: [...idSet] } },
    select: { id: true, parentId: true, iterationId: true },
  });
  if (picked.length === 0) return { error: "未找到任务。" };
  const sourceIt = picked[0]!.iterationId;
  if (!picked.every((p) => p.iterationId === sourceIt)) {
    return { error: "一次仅支持移动同一迭代下的任务。" };
  }
  if (sourceIt === target) return { error: "目标迭代与当前相同。" };

  const allInSource = await prisma.executionTask.findMany({
    where: { iterationId: sourceIt },
    select: { id: true, parentId: true },
  });
  const allIds = new Set(allInSource.map((r) => r.id));
  for (const id of idSet) {
    if (!allIds.has(id)) return { error: "任务数据不一致，请刷新。" };
  }

  const parentMap = new Map(allInSource.map((r) => [r.id, r.parentId]));

  const childrenBy = new Map<string | null, string[]>();
  for (const r of allInSource) {
    const k = r.parentId ?? null;
    if (!childrenBy.has(k)) childrenBy.set(k, []);
    childrenBy.get(k)!.push(r.id);
  }

  const collectSubtree = (root: string): Set<string> => {
    const S = new Set<string>();
    const walk = (id: string) => {
      S.add(id);
      for (const c of childrenBy.get(id) ?? []) walk(c);
    };
    walk(root);
    return S;
  };

  const roots = [...idSet].filter((id) => {
    const p = parentMap.get(id) ?? null;
    return !p || !idSet.has(p);
  });

  const S = new Set<string>();
  for (const r of roots) {
    collectSubtree(r).forEach((x) => S.add(x));
  }

  const origParent = new Map<string, string | null>();
  for (const id of S) {
    origParent.set(id, parentMap.get(id) ?? null);
  }

  await prisma.$transaction(async (tx) => {
    for (const id of S) {
      await tx.executionTask.update({
        where: { id },
        data: { iterationId: target, parentId: null },
      });
    }
    for (const id of S) {
      const op = origParent.get(id) ?? null;
      if (op && S.has(op)) {
        await tx.executionTask.update({
          where: { id },
          data: { parentId: op },
        });
      }
    }
  });

  revalidatePath("/executions");
  return { ok: true };
}

export async function createExecutionTaskNode(input: {
  iterationId: string;
  parentId: string | null;
  title: string;
  description?: string | null;
}): Promise<{ id?: string; error?: string }> {
  const iterationId = input.iterationId.trim();
  const title = input.title.trim();
  const parentId = input.parentId?.trim() || null;
  if (!iterationId) return { error: "缺少迭代。" };
  if (!title) return { error: "标题不能为空。" };

  const max = await prisma.executionTask.aggregate({
    where: { iterationId, parentId },
    _max: { sortOrder: true },
  });
  const sortOrder = (max._max.sortOrder ?? 0) + 1;
  const row = await prisma.executionTask.create({
    data: {
      iterationId,
      parentId,
      title,
      description: input.description?.trim() || null,
      sortOrder,
      createdBy: "系统",
      updatedBy: "系统",
    },
    select: { id: true },
  });
  revalidatePath("/executions");
  return { id: row.id };
}

export async function renameExecutionTaskNode(input: {
  id: string;
  title: string;
}): Promise<ActionResult> {
  const id = input.id.trim();
  const title = input.title.trim();
  if (!id) return { error: "缺少 id。" };
  if (!title) return { error: "标题不能为空。" };
  await prisma.executionTask.update({
    where: { id },
    data: { title },
    select: { id: true },
  });
  revalidatePath("/executions");
  revalidatePath(`/executions/task/${id}`);
  return { ok: true };
}

export async function updateExecutionTaskDetail(input: {
  id: string;
  title: string;
  description: string;
}): Promise<ActionResult> {
  const id = input.id.trim();
  if (!id) return { error: "缺少 id。" };
  const title = input.title.trim();
  if (!title) return { error: "标题不能为空。" };
  await prisma.executionTask.update({
    where: { id },
    data: { title, description: input.description.trim() || null },
    select: { id: true },
  });
  revalidatePath("/executions");
  revalidatePath(`/executions/task/${id}`);
  return { ok: true };
}

export async function getExecutionTaskDetail(id: string) {
  const taskId = id.trim();
  if (!taskId) return null;
  return prisma.executionTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      description: true,
      iterationId: true,
      parentId: true,
      createdAt: true,
      updatedAt: true,
      iteration: {
        select: {
          id: true,
          name: true,
          code: true,
          productId: true,
          product: { select: { id: true, name: true } },
        },
      },
      linkedCases: {
        orderBy: [{ createdAt: "desc" }],
        select: {
          createdAt: true,
          testCase: {
            select: {
              id: true,
              caseNo: true,
              title: true,
              status: true,
              priority: true,
              maintainer: true,
              submitter: true,
              updatedAt: true,
              createdAt: true,
              folder: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
}

export async function addExecutionTaskLinkedTestCases(
  executionTaskId: string,
  testCaseIds: string[],
): Promise<ActionResult> {
  const taskId = executionTaskId.trim();
  if (!taskId) return { error: "缺少任务 id。" };
  const ids = Array.from(new Set(testCaseIds.map((x) => x.trim()).filter(Boolean)));
  if (ids.length === 0) return { error: "请选择要导入的用例。" };

  // SQLite 下 createMany 的 skipDuplicates 不可用，需手动去重
  const existed = await prisma.executionTaskTestCase.findMany({
    where: { executionTaskId: taskId, testCaseId: { in: ids } },
    select: { testCaseId: true },
  });
  const existedSet = new Set(existed.map((x) => x.testCaseId));
  const toCreate = ids.filter((id) => !existedSet.has(id));
  if (toCreate.length > 0) {
    await prisma.executionTaskTestCase.createMany({
      data: toCreate.map((id) => ({ executionTaskId: taskId, testCaseId: id })),
    });
  }
  revalidatePath(`/executions/task/${taskId}`);
  revalidatePath("/executions");
  return { ok: true };
}

export async function removeExecutionTaskLinkedTestCases(
  executionTaskId: string,
  testCaseIds: string[],
): Promise<ActionResult> {
  const taskId = executionTaskId.trim();
  if (!taskId) return { error: "缺少任务 id。" };
  const ids = Array.from(new Set(testCaseIds.map((x) => x.trim()).filter(Boolean)));
  if (ids.length === 0) return { error: "未选择要移除的用例。" };

  await prisma.executionTaskTestCase.deleteMany({
    where: { executionTaskId: taskId, testCaseId: { in: ids } },
  });
  revalidatePath(`/executions/task/${taskId}`);
  revalidatePath("/executions");
  return { ok: true };
}

export async function getExecutionTaskCaseResult(input: {
  executionTaskId: string;
  testCaseId: string;
}): Promise<{ result?: { executionResult: string | null; executedAt: string | null }; error?: string }> {
  try {
    const taskId = input.executionTaskId.trim();
    const caseId = input.testCaseId.trim();
    if (!taskId || !caseId) return { result: { executionResult: null, executedAt: null } };
    const row = await prisma.executionTaskTestCase.findUnique({
      where: { executionTaskId_testCaseId: { executionTaskId: taskId, testCaseId: caseId } },
      select: { executionResult: true, executedAt: true },
    });
    return {
      result: {
        executionResult: row?.executionResult ?? null,
        executedAt: row?.executedAt ? row.executedAt.toISOString() : null,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "读取执行结果失败" };
  }
}

export async function saveExecutionTaskCaseResult(input: {
  executionTaskId: string;
  testCaseId: string;
  executionResult: string | null;
}): Promise<ActionResult> {
  try {
    const taskId = input.executionTaskId.trim();
    const caseId = input.testCaseId.trim();
    if (!taskId) return { error: "缺少任务 id。" };
    if (!caseId) return { error: "缺少用例 id。" };
    const text = input.executionResult?.trim() || null;
    await prisma.executionTaskTestCase.update({
      where: { executionTaskId_testCaseId: { executionTaskId: taskId, testCaseId: caseId } },
      data: { executionResult: text, executedAt: text ? new Date() : null },
      select: { testCaseId: true },
    });
    if (text) {
      await prisma.testCaseOpLog.create({
        data: {
          testCaseId: caseId,
          action: "EXECUTION_RESULT",
          detail: `执行任务记录执行结果（task=${taskId}）：\n${text}`,
        },
        select: { id: true },
      });
    }
    revalidatePath(`/executions/task/${taskId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "保存执行结果失败" };
  }
}

export type ExecutionTaskCaseExecRecordDTO = {
  id: string;
  executedAt: string;
  status: TestCaseStatus;
  executor: string | null;
  result: string | null;
  images: unknown | null;
  note: string | null;
};

export async function listExecutionTaskCaseExecRecords(input: {
  executionTaskId: string;
  testCaseId: string;
}): Promise<{ records?: ExecutionTaskCaseExecRecordDTO[]; error?: string }> {
  try {
    const taskId = input.executionTaskId.trim();
    const caseId = input.testCaseId.trim();
    if (!taskId || !caseId) return { records: [] };
    const rows = await prisma.executionTaskTestCaseExecRecord.findMany({
      where: { executionTaskId: taskId, testCaseId: caseId },
      orderBy: { executedAt: "desc" },
      select: { id: true, executedAt: true, status: true, executor: true, result: true, images: true, note: true },
      take: 200,
    });
    return {
      records: rows.map((r) => ({
        id: r.id,
        executedAt: r.executedAt.toISOString(),
        status: r.status,
        executor: r.executor,
        result: r.result ?? null,
        images: (r as unknown as { images?: unknown }).images ?? null,
        note: r.note,
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "读取执行记录失败" };
  }
}

export async function addExecutionTaskCaseExecRecord(input: {
  executionTaskId: string;
  testCaseId: string;
  status: TestCaseStatus;
  executor?: string | null;
  result?: string | null;
  images?: unknown | null;
  note?: string | null;
}): Promise<ActionResult> {
  try {
    const taskId = input.executionTaskId.trim();
    const caseId = input.testCaseId.trim();
    if (!taskId) return { error: "缺少任务 id。" };
    if (!caseId) return { error: "缺少用例 id。" };

    const row = await prisma.executionTaskTestCaseExecRecord.create({
      data: {
        executionTaskId: taskId,
        testCaseId: caseId,
        status: input.status,
        executor: input.executor?.trim() || null,
        result: input.result?.trim() || null,
        images:
          input.images === undefined
            ? undefined
            : input.images === null
              ? Prisma.JsonNull
              : (input.images as Prisma.InputJsonValue),
        note: input.note?.trim() || null,
      },
      select: { id: true, executedAt: true, status: true, executor: true, result: true, note: true },
    });

    const stLabel = String(row.status);
    const ex = row.executor?.trim() || "—";
    const nt = row.note?.trim();
    const rs = row.result?.trim();
    await prisma.testCaseOpLog.create({
      data: {
        testCaseId: caseId,
        action: "TASK_EXEC_RECORD",
        detail: [
          `执行任务执行记录（task=${taskId}）`,
          `时间：${row.executedAt.toISOString()}`,
          `状态：${stLabel}`,
          `执行人：${ex}`,
          rs ? `执行结果：\n${rs}` : "",
          nt ? `备注：${nt}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      select: { id: true },
    });

    revalidatePath(`/executions/task/${taskId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "保存执行记录失败" };
  }
}

export type TestCaseExecRecordDTO = ExecutionTaskCaseExecRecordDTO & {
  executionTaskId: string;
  executionTaskTitle: string | null;
};

export async function listTestCaseExecRecords(input: {
  testCaseId: string;
}): Promise<{ records?: TestCaseExecRecordDTO[]; error?: string }> {
  try {
    const caseId = input.testCaseId.trim();
    if (!caseId) return { records: [] };
    const rows = await prisma.executionTaskTestCaseExecRecord.findMany({
      where: { testCaseId: caseId },
      orderBy: { executedAt: "desc" },
      select: {
        id: true,
        executedAt: true,
        status: true,
        executor: true,
        result: true,
        images: true,
        note: true,
        executionTaskId: true,
        executionTask: { select: { title: true } },
      },
      take: 200,
    });
    return {
      records: rows.map((r) => ({
        id: r.id,
        executedAt: r.executedAt.toISOString(),
        status: r.status,
        executor: r.executor,
        result: r.result ?? null,
        images: (r as unknown as { images?: unknown }).images ?? null,
        note: r.note,
        executionTaskId: r.executionTaskId,
        executionTaskTitle: r.executionTask?.title ?? null,
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "读取执行记录失败" };
  }
}

