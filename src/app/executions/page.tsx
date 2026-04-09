import { listExecutionTaskIterations } from "@/app/actions/executions";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { ExecutionTaskTreeClient } from "@/components/ExecutionTaskTreeClient";

export default async function ExecutionsPage({
  searchParams,
}: {
  searchParams: Promise<{ iterationId?: string }>;
}) {
  const sp = await searchParams;
  const iterations = await listExecutionTaskIterations();
  const iterClientKey = sp.iterationId?.trim() ?? "";
  return (
    <div className="p-8">
      <ModulePageHeader
        title="执行任务"
        description="按迭代创建执行任务（支持树形层级）；进入任务后可从测试用例库导入用例并查看已导入列表。"
      />
      <ExecutionTaskTreeClient
        key={iterClientKey}
        initialIterations={iterations}
        initialIterationId={sp.iterationId}
      />
    </div>
  );
}

