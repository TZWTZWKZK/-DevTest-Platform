import { getExecutionTaskDetail, listExecutionTasksFlat } from "@/app/actions/executions";
import { listFoldersFlat } from "@/app/actions/test-cases";
import { ExecutionTaskDetailClient } from "@/components/ExecutionTaskDetailClient";

export default async function ExecutionTaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const task = await getExecutionTaskDetail(id);
  if (!task) {
    return (
      <div className="p-8">
        <div className="text-sm text-zinc-500">任务不存在或已删除。</div>
      </div>
    );
  }
  const [tasks, folders] = await Promise.all([
    listExecutionTasksFlat(task.iterationId),
    listFoldersFlat(task.iteration.productId),
  ]);
  return (
    <div className="p-8">
      <ExecutionTaskDetailClient
        initial={task}
        siblingTasks={tasks}
        testCaseFolders={folders}
      />
    </div>
  );
}

