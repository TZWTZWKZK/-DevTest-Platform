import { listIterationOptions } from "@/app/actions/requirements";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { RequirementTreeClient } from "@/components/RequirementTreeClient";

export default async function RequirementsPage({
  searchParams,
}: {
  searchParams: Promise<{
    iterationId?: string;
    focusNode?: string;
  }>;
}) {
  const sp = await searchParams;
  const initialIterationId = sp.iterationId?.trim() || undefined;
  const initialFocusNodeId = sp.focusNode?.trim() || undefined;
  const iterations = await listIterationOptions();
  return (
    <div className="p-8">
      <ModulePageHeader
        title="需求管理"
        description="按迭代维护树形需求目录（无限层级）；点击节点进入详情编辑。"
      />
      <RequirementTreeClient
        initialIterations={iterations}
        initialIterationId={initialIterationId}
        initialFocusNodeId={initialFocusNodeId}
      />
    </div>
  );
}
