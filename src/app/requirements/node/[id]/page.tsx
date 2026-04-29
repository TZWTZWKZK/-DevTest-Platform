import { notFound } from "next/navigation";
import {
  getRequirementNodeDetail,
  getRequirementOpLogs,
} from "@/app/actions/requirements";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { RequirementNodeDetailClient } from "@/components/RequirementNodeDetailClient";

export default async function RequirementNodePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [node, opLogs] = await Promise.all([
    getRequirementNodeDetail(id),
    getRequirementOpLogs(id, 50),
  ]);
  if (!node) notFound();

  const breadcrumb = `${node.iteration.product.name} / ${node.iteration.name} / ${node.title}`;

  return (
    <div className="p-8">
      <ModulePageHeader
        title="需求管理 · 节点详情"
        description="编辑需求信息；测试设计将按需求挂载树形设计节点。"
      />
      <RequirementNodeDetailClient
        nodeId={node.id}
        iterationId={node.iterationId}
        breadcrumb={breadcrumb}
        initialTitle={node.title}
        initialWbsId={node.wbsId}
        initialDescription={node.description}
        initialTaskProgress={node.taskProgress}
        initialLatestProgress={node.latestProgress}
        initialPriority={node.priority}
        initialStatus={node.status}
        initialSubmitter={node.submitter}
        initialDevOwner={node.devOwner}
        initialTestOwner={node.testOwner}
        initialPlanStartAt={node.planStartAt?.toISOString() ?? null}
        initialPlanEndAt={node.planEndAt?.toISOString() ?? null}
        initialUpdatedAt={node.updatedAt.toISOString()}
        initialAttachments={node.attachments.map((a) => ({
          id: a.id,
          name: a.name,
          url: a.url,
          createdAt: a.createdAt.toISOString(),
        }))}
        initialOpLogs={opLogs}
      />
    </div>
  );
}

