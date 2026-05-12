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
  /** 通过率分子：导入用例中 TestCase.status 为通过、废弃、转需求的条数之和 */
  passedCaseCount: number;
  /** 执行情况：按用例“最近一次执行状态”聚合（NONE 表示 executionResult 为空） */
  latestStatusCounts: {
    PASSED: number;
    FAILED: number;
    BLOCKED: number;
    DEPRECATED: number;
    REQ_TRANSFER: number;
    NONE: number;
  };
};

const UI_PREF_KEY_EXEC_TASK_COLS = "ui.execTask.columns.v1";
const UI_PREF_KEY_EXEC_TASK_IMPORTED_COLS = "ui.execTask.importedCase.columns.v1";
const UI_PREF_KEY_EXEC_TASK_FILTERS = "ui.execTask.filters.v1";
const UI_PREF_KEY_EXEC_TASK_FILTER_PANEL = "ui.execTask.filterPanel.v1";
const UI_PREF_KEY_GLOBAL_TEST_CASE_SIDEBAR = "ui.global.testCases.sidebar.v1";
const UI_PREF_KEY_GLOBAL_TEST_DESIGN_ITERATION = "ui.global.testDesign.iteration.v1";
/** 测试设计页需求目录：各迭代下需求节点的展开/收起（全局共享，写入 DB） */
const UI_PREF_KEY_TEST_DESIGN_REQ_TREE_EXPAND = "ui.testDesign.reqTree.expand.v1";
const UI_PREF_KEY_GLOBAL_EXECUTION_ITERATION = "ui.global.executions.iteration.v1";
const UI_PREF_KEY_GLOBAL_ITERATION_PRODUCT = "ui.global.iterations.product.v1";
const UI_PREF_KEY_GLOBAL_REQUIREMENT_ITERATION = "ui.global.requirements.iteration.v1";
const UI_PREF_KEY_GLOBAL_TEST_CASE_EXEC_RESULT_HEIGHT =
  "ui.global.testCase.execResultTextareaHeight.v1";

async function readUiPreference<T>(
  key: string,
  fallback: T,
): Promise<{ value: T; error?: string }> {
  try {
    const row = await prisma.uiPreference.findUnique({
      where: { key },
      select: { value: true },
    });
    if (!row?.value) return { value: fallback };
    return { value: JSON.parse(row.value) as T };
  } catch (e) {
    return {
      value: fallback,
      error: e instanceof Error ? e.message : "读取偏好失败",
    };
  }
}

async function writeUiPreference(key: string, value: unknown): Promise<ActionResult> {
  try {
    await prisma.uiPreference.upsert({
      where: { key },
      create: { key, value: JSON.stringify(value ?? null) },
      update: { value: JSON.stringify(value ?? null) },
      select: { key: true },
    });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "保存偏好失败" };
  }
}

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

export async function getExecutionTaskListFilterPreference(): Promise<{
  status?: "" | TestCaseStatus | "NONE";
  passRateMin?: number | null;
  passRateMax?: number | null;
  error?: string;
}> {
  const r = await readUiPreference<{
    status?: unknown;
    passRateMin?: unknown;
    passRateMax?: unknown;
  }>(UI_PREF_KEY_EXEC_TASK_FILTERS, {});
  const raw = r.value ?? {};
  const status =
    raw.status === "" ||
    raw.status === "PASSED" ||
    raw.status === "FAILED" ||
    raw.status === "BLOCKED" ||
    raw.status === "DEPRECATED" ||
    raw.status === "REQ_TRANSFER" ||
    raw.status === "NONE"
      ? (raw.status as "" | TestCaseStatus | "NONE")
      : "";
  const passRateMin =
    typeof raw.passRateMin === "number" && Number.isFinite(raw.passRateMin)
      ? raw.passRateMin
      : null;
  const passRateMax =
    typeof raw.passRateMax === "number" && Number.isFinite(raw.passRateMax)
      ? raw.passRateMax
      : null;
  return {
    status,
    passRateMin,
    passRateMax,
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function saveExecutionTaskListFilterPreference(input: {
  status: "" | TestCaseStatus | "NONE";
  passRateMin: number | null;
  passRateMax: number | null;
}): Promise<ActionResult> {
  return writeUiPreference(UI_PREF_KEY_EXEC_TASK_FILTERS, {
    status: input.status ?? "",
    passRateMin:
      typeof input.passRateMin === "number" && Number.isFinite(input.passRateMin)
        ? input.passRateMin
        : null,
    passRateMax:
      typeof input.passRateMax === "number" && Number.isFinite(input.passRateMax)
        ? input.passRateMax
        : null,
  });
}

export async function getExecutionTaskListFilterPanelPreference(): Promise<{
  order?: Array<"status" | "passRateRange">;
  visible?: Partial<Record<"status" | "passRateRange", boolean>>;
  error?: string;
}> {
  const r = await readUiPreference<{
    order?: unknown;
    visible?: unknown;
  }>(UI_PREF_KEY_EXEC_TASK_FILTER_PANEL, {});
  const raw = r.value ?? {};
  const allow = new Set(["status", "passRateRange"]);
  const order = Array.isArray(raw.order)
    ? (raw.order.filter((x) => typeof x === "string" && allow.has(x)) as Array<
        "status" | "passRateRange"
      >)
    : undefined;
  const visible: Partial<Record<"status" | "passRateRange", boolean>> = {};
  if (raw.visible && typeof raw.visible === "object") {
    for (const k of allow) {
      const v = (raw.visible as Record<string, unknown>)[k];
      if (typeof v === "boolean") visible[k as "status" | "passRateRange"] = v;
    }
  }
  return { order, visible, ...(r.error ? { error: r.error } : {}) };
}

export async function saveExecutionTaskListFilterPanelPreference(input: {
  order: Array<"status" | "passRateRange">;
  visible: Partial<Record<"status" | "passRateRange", boolean>>;
}): Promise<ActionResult> {
  return writeUiPreference(UI_PREF_KEY_EXEC_TASK_FILTER_PANEL, {
    order: input.order,
    visible: input.visible,
  });
}

export async function getGlobalTestCaseSidebarPreference(): Promise<{
  iterationCode?: string;
  folderExpandedById?: Record<string, boolean>;
  error?: string;
}> {
  const r = await readUiPreference<{
    iterationCode?: unknown;
    folderExpandedById?: unknown;
  }>(UI_PREF_KEY_GLOBAL_TEST_CASE_SIDEBAR, {});
  const data = r.value ?? {};
  const iterationCode =
    typeof data.iterationCode === "string" ? data.iterationCode : "";
  const folderExpandedById: Record<string, boolean> = {};
  if (data.folderExpandedById && typeof data.folderExpandedById === "object") {
    for (const [k, v] of Object.entries(data.folderExpandedById as Record<string, unknown>)) {
      if (typeof k === "string" && typeof v === "boolean") folderExpandedById[k] = v;
    }
  }
  return {
    iterationCode,
    folderExpandedById,
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function saveGlobalTestCaseSidebarPreference(input: {
  iterationCode: string;
  folderExpandedById: Record<string, boolean>;
}): Promise<ActionResult> {
  return writeUiPreference(UI_PREF_KEY_GLOBAL_TEST_CASE_SIDEBAR, {
    iterationCode: input.iterationCode ?? "",
    folderExpandedById: input.folderExpandedById ?? {},
  });
}

export async function getGlobalTestDesignIterationPreference(): Promise<{
  iterationCode?: string;
  error?: string;
}> {
  const r = await readUiPreference<{ iterationCode?: unknown }>(
    UI_PREF_KEY_GLOBAL_TEST_DESIGN_ITERATION,
    {},
  );
  return {
    iterationCode: typeof r.value?.iterationCode === "string" ? r.value.iterationCode : "",
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function saveGlobalTestDesignIterationPreference(input: {
  iterationCode: string;
}): Promise<ActionResult> {
  return writeUiPreference(UI_PREF_KEY_GLOBAL_TEST_DESIGN_ITERATION, {
    iterationCode: input.iterationCode ?? "",
  });
}

export async function getTestDesignReqTreeExpandPreference(): Promise<{
  byIteration: Record<string, Record<string, boolean>>;
  error?: string;
}> {
  const r = await readUiPreference<{ byIteration?: unknown }>(
    UI_PREF_KEY_TEST_DESIGN_REQ_TREE_EXPAND,
    { byIteration: {} },
  );
  const byIteration: Record<string, Record<string, boolean>> = {};
  const raw = r.value?.byIteration;
  if (raw && typeof raw === "object") {
    for (const [ik, iv] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof ik !== "string" || typeof iv !== "object" || !iv) continue;
      const inner: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(iv as Record<string, unknown>)) {
        if (typeof k === "string" && typeof v === "boolean") inner[k] = v;
      }
      byIteration[ik] = inner;
    }
  }
  return { byIteration, ...(r.error ? { error: r.error } : {}) };
}

export async function saveTestDesignReqTreeExpandPreference(input: {
  iterationCode: string;
  expandedByReqId: Record<string, boolean>;
}): Promise<ActionResult> {
  const ic = input.iterationCode.trim();
  const cur = await readUiPreference<{ byIteration?: Record<string, Record<string, boolean>> }>(
    UI_PREF_KEY_TEST_DESIGN_REQ_TREE_EXPAND,
    { byIteration: {} },
  );
  const byIteration = { ...(cur.value?.byIteration ?? {}) };
  byIteration[ic] = input.expandedByReqId ?? {};
  return writeUiPreference(UI_PREF_KEY_TEST_DESIGN_REQ_TREE_EXPAND, { byIteration });
}

export async function getGlobalExecutionIterationPreference(): Promise<{
  iterationId?: string;
  error?: string;
}> {
  const r = await readUiPreference<{ iterationId?: unknown }>(
    UI_PREF_KEY_GLOBAL_EXECUTION_ITERATION,
    {},
  );
  return {
    iterationId: typeof r.value?.iterationId === "string" ? r.value.iterationId : "",
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function saveGlobalExecutionIterationPreference(input: {
  iterationId: string;
}): Promise<ActionResult> {
  return writeUiPreference(UI_PREF_KEY_GLOBAL_EXECUTION_ITERATION, {
    iterationId: input.iterationId ?? "",
  });
}

export async function getGlobalIterationProductPreference(): Promise<{
  productId?: string;
  error?: string;
}> {
  const r = await readUiPreference<{ productId?: unknown }>(
    UI_PREF_KEY_GLOBAL_ITERATION_PRODUCT,
    {},
  );
  return {
    productId: typeof r.value?.productId === "string" ? r.value.productId : "",
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function saveGlobalIterationProductPreference(input: {
  productId: string;
}): Promise<ActionResult> {
  return writeUiPreference(UI_PREF_KEY_GLOBAL_ITERATION_PRODUCT, {
    productId: input.productId ?? "",
  });
}

export async function getGlobalRequirementIterationPreference(): Promise<{
  iterationId?: string;
  error?: string;
}> {
  const r = await readUiPreference<{ iterationId?: unknown }>(
    UI_PREF_KEY_GLOBAL_REQUIREMENT_ITERATION,
    {},
  );
  return {
    iterationId: typeof r.value?.iterationId === "string" ? r.value.iterationId : "",
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function saveGlobalRequirementIterationPreference(input: {
  iterationId: string;
}): Promise<ActionResult> {
  return writeUiPreference(UI_PREF_KEY_GLOBAL_REQUIREMENT_ITERATION, {
    iterationId: input.iterationId ?? "",
  });
}

export async function getGlobalTestCaseExecResultHeightPreference(): Promise<{
  height?: number;
  error?: string;
}> {
  const r = await readUiPreference<{ height?: unknown }>(
    UI_PREF_KEY_GLOBAL_TEST_CASE_EXEC_RESULT_HEIGHT,
    {},
  );
  const h = r.value?.height;
  return {
    height: typeof h === "number" && Number.isFinite(h) ? h : undefined,
    ...(r.error ? { error: r.error } : {}),
  };
}

export async function saveGlobalTestCaseExecResultHeightPreference(input: {
  height: number;
}): Promise<ActionResult> {
  return writeUiPreference(UI_PREF_KEY_GLOBAL_TEST_CASE_EXEC_RESULT_HEIGHT, {
    height: input.height,
  });
}

export async function listExecutionTaskIterations(): Promise<
  Array<{ id: string; label: string; taskCount: number; productId: string }>
> {
  return listExecutionTaskIterationsByProduct();
}

export async function listExecutionTaskIterationsByProduct(
  productId?: string | null,
): Promise<Array<{ id: string; label: string; taskCount: number; productId: string }>> {
  const pid = (productId ?? "").trim();
  const rows = await prisma.iteration.findMany({
    where: pid ? { productId: pid } : undefined,
    orderBy: [{ updatedAt: "desc" }],
    select: {
      id: true,
      name: true,
      code: true,
      productId: true,
      product: { select: { name: true } },
      _count: { select: { executionTasks: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    label: `${r.product.name} · ${r.name}${r.code ? `（${r.code}）` : ""}`,
    taskCount: r._count.executionTasks,
    productId: r.productId,
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

  const emptyCounts = () => ({
    PASSED: 0,
    FAILED: 0,
    BLOCKED: 0,
    DEPRECATED: 0,
    REQ_TRANSFER: 0,
    NONE: 0,
  });
  const countsByTask = new Map<string, ReturnType<typeof emptyCounts>>();
  for (const tid of taskIds) countsByTask.set(tid, emptyCounts());

  // 口径对齐：执行任务详情页「已导入用例」表格的“状态”列来源于 TestCase.status。
  // 因此列表汇总也以 TestCase.status 为准：
  // - 通过率分子 = PASSED + DEPRECATED + REQ_TRANSFER（废弃/转需求视同达标）
  // - 执行率(执行情况) = status 不为空 / 总数（NONE=为空）
  const links = await prisma.executionTaskTestCase.findMany({
    where: { executionTaskId: { in: taskIds } },
    select: { executionTaskId: true, testCase: { select: { status: true } } },
  });
  for (const link of links) {
    const counts = countsByTask.get(link.executionTaskId) ?? emptyCounts();
    countsByTask.set(link.executionTaskId, counts);
    const st = link.testCase.status;
    if (!st) {
      counts.NONE += 1;
    } else if (st === "PASSED") counts.PASSED += 1;
    else if (st === "FAILED") counts.FAILED += 1;
    else if (st === "DEPRECATED") counts.DEPRECATED += 1;
    else if (st === "REQ_TRANSFER") counts.REQ_TRANSFER += 1;
    else counts.BLOCKED += 1;
  }

  return rows.map((r) => {
    const c = countsByTask.get(r.id) ?? emptyCounts();
    return {
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
      passedCaseCount: c.PASSED + c.DEPRECATED + c.REQ_TRANSFER,
      latestStatusCounts: c,
    };
  });
}

/** 批量删除：无子任务、无已导入用例的叶子方可删；删除任务时执行记录表会随任务级联删除 */
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

  const blockedData = picked.filter((r) => r._count.linkedCases > 0);
  if (blockedData.length > 0) {
    const names = blockedData.map((r) => `「${r.title}」`).slice(0, 8);
    const suffix =
      blockedData.length > 8
        ? ` …（共 ${blockedData.length} 项仍含已导入用例）`
        : "";
    return {
      error: `以下任务仍有已导入用例，请先在任务详情中移除后再删除：${names.join("、")}${suffix}`,
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

  const task = await prisma.executionTask.findUnique({
    where: { id: taskId },
    select: { iteration: { select: { productId: true } } },
  });
  const expectedPid = task?.iteration.productId;
  if (!expectedPid) return { error: "任务或迭代数据不完整。" };

  const caseRows = await prisma.testCase.findMany({
    where: { id: { in: ids } },
    select: { id: true, folder: { select: { productId: true } } },
  });
  if (caseRows.length !== ids.length) {
    return { error: "部分用例不存在或已被删除。" };
  }
  const baseline = await prisma.product.findFirst({
    where: { isBaseline: true },
    select: { id: true },
  });

  for (const c of caseRows) {
    const fp = c.folder.productId;
    if (fp === expectedPid) continue;
    if (baseline && fp === baseline.id) continue;
    return {
      error:
        "只能导入当前迭代所属产品用例库中的用例，或共享 Baseline 用例库中的用例。",
    };
  }

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

  // 先归档再删执行记录；再删导入链接
  await prisma.$transaction(async (tx) => {
    const execRows = await tx.executionTaskTestCaseExecRecord.findMany({
      where: { executionTaskId: taskId, testCaseId: { in: ids } },
    });
    if (execRows.length > 0) {
      await tx.executionTaskTestCaseExecRecordDeleted.createMany({
        data: execRows.map((r) => ({
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
    await tx.executionTaskTestCaseExecRecord.deleteMany({
      where: { executionTaskId: taskId, testCaseId: { in: ids } },
    });
    await tx.executionTaskTestCase.deleteMany({
      where: { executionTaskId: taskId, testCaseId: { in: ids } },
    });
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
    // 防御：避免误粘贴超大 base64 文本导致数据库列长度错误
    if (text && text.length > 20000) {
      return {
        error:
          "执行结果文本过长（超过 20000 字符）。请将截图放在截图区域，文字结果保留关键信息后再保存。",
      };
    }
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

    let normalizedImages: Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined =
      undefined;
    if (input.images !== undefined) {
      if (input.images === null) {
        normalizedImages = Prisma.JsonNull;
      } else if (typeof input.images === "string") {
        const s = input.images.trim();
        if (!s) {
          normalizedImages = Prisma.JsonNull;
        } else {
          try {
            const parsed = JSON.parse(s) as unknown;
            normalizedImages =
              parsed === null
                ? Prisma.JsonNull
                : (parsed as Prisma.InputJsonValue);
          } catch {
            return { error: "执行截图数据格式无效，请重新粘贴截图后再保存。" };
          }
        }
      } else {
        normalizedImages = input.images as Prisma.InputJsonValue;
      }
    }

    const row = await prisma.executionTaskTestCaseExecRecord.create({
      data: {
        executionTaskId: taskId,
        testCaseId: caseId,
        status: input.status,
        executor: input.executor?.trim() || null,
        result: input.result?.trim() || null,
        images: normalizedImages,
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

/** 删除单条执行任务内执行记录：先写入误删归档表 */
export async function deleteExecutionTaskCaseExecRecord(
  recordId: string,
): Promise<ActionResult> {
  const id = recordId.trim();
  if (!id) return { error: "无效记录" };
  try {
    let taskId: string | null = null;
    await prisma.$transaction(async (tx) => {
      const r = await tx.executionTaskTestCaseExecRecord.findUnique({
        where: { id },
      });
      if (!r) return;
      taskId = r.executionTaskId;
      await tx.executionTaskTestCaseExecRecordDeleted.create({
        data: {
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
        },
      });
      await tx.executionTaskTestCaseExecRecord.delete({ where: { id } });
    });
    revalidatePath("/test-cases");
    revalidatePath("/executions");
    if (taskId) revalidatePath(`/executions/task/${taskId}`);
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "删除失败" };
  }
}

export type DeletedTestCaseExecRecordRow = {
  /** 误删归档表主键，用于恢复勾选 */
  archiveId: string;
  originalId: string;
  executionTaskId: string;
  executionTaskTitle: string | null;
  executedAt: string;
  status: TestCaseStatus;
  executor: string | null;
  deletedAt: string;
};

/** 某用例在误删归档中的执行记录（从本弹窗删除单条时写入） */
export async function listDeletedTestCaseExecRecords(input: {
  testCaseId: string;
}): Promise<{ rows?: DeletedTestCaseExecRecordRow[]; error?: string }> {
  const caseId = input.testCaseId.trim();
  if (!caseId) return { rows: [] };
  try {
    const rows = await prisma.executionTaskTestCaseExecRecordDeleted.findMany({
      where: { testCaseId: caseId },
      orderBy: { deletedAt: "desc" },
      take: 200,
    });
    if (rows.length === 0) return { rows: [] };
    const taskIds = [...new Set(rows.map((r) => r.executionTaskId))];
    const tasks = await prisma.executionTask.findMany({
      where: { id: { in: taskIds } },
      select: { id: true, title: true },
    });
    const titleById = new Map(tasks.map((t) => [t.id, t.title ?? ""]));
    return {
      rows: rows.map((r) => ({
        archiveId: r.id,
        originalId: r.originalId,
        executionTaskId: r.executionTaskId,
        executionTaskTitle: titleById.get(r.executionTaskId) ?? null,
        executedAt: r.executedAt.toISOString(),
        status: r.status,
        executor: r.executor,
        deletedAt: r.deletedAt.toISOString(),
      })),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "读取误删执行记录失败" };
  }
}

export async function restoreTestCaseExecRecordsFromArchive(
  archiveIds: string[],
): Promise<ActionResult & { restored?: number }> {
  const ids = Array.from(
    new Set(archiveIds.map((x) => x.trim()).filter(Boolean)),
  );
  if (ids.length === 0) return { error: "请选择要恢复的记录" };
  const taskIdsToRevalidate = new Set<string>();
  let restored = 0;
  try {
    await prisma.$transaction(async (tx) => {
      for (const aid of ids) {
        const arc = await tx.executionTaskTestCaseExecRecordDeleted.findUnique({
          where: { id: aid },
        });
        if (!arc) continue;
        await tx.executionTaskTestCaseExecRecord.create({
          data: {
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
          where: { id: aid },
        });
        taskIdsToRevalidate.add(arc.executionTaskId);
        restored += 1;
      }
    });
    revalidatePath("/test-cases");
    revalidatePath("/executions");
    for (const tid of taskIdsToRevalidate) {
      revalidatePath(`/executions/task/${tid}`);
    }
    if (restored === 0) {
      return { error: "未找到可恢复的记录（可能已被恢复或 id 无效）" };
    }
    return { ok: true, restored };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "恢复失败" };
  }
}

