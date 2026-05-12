import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getLinkedTestCaseIds,
  getTestDesignNodeDetail,
  getTestDesignOpLogs,
  listTestCasesForPicker,
} from "@/app/actions/test-design";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { TestDesignNodeDetailClient } from "@/components/TestDesignNodeDetailClient";

export default async function TestDesignNodePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const node = await getTestDesignNodeDetail(id);
  if (!node) notFound();

  const [pickerCases, linkedIds, opLogs] = await Promise.all([
    listTestCasesForPicker(node.requirement.iteration.productId, 600),
    getLinkedTestCaseIds(id),
    getTestDesignOpLogs(id, 12),
  ]);

  const { requirement } = node;
  const breadcrumb = `${requirement.iteration.product.name} / ${requirement.iteration.name} / ${requirement.title} / ${node.title}`;

  return (
    <div className="p-8">
      <ModulePageHeader
        title="测试设计 · 节点详情"
        description="编辑节点基本信息，并关联测试用例库中的用例。"
      />
      <TestDesignNodeDetailClient
        nodeId={node.id}
        pickerProductId={node.requirement.iteration.productId}
        backToTreeContext={{
          productId: requirement.iteration.productId,
          iterationCode: requirement.iteration.code,
          requirementId: requirement.id,
        }}
        breadcrumb={breadcrumb}
        initialTitle={node.title}
        initialDescription={node.description}
        initialPrecondition={
          (node as unknown as Record<string, unknown>).precondition as string | null
        }
        initialOperationSteps={
          (node as unknown as Record<string, unknown>).operationSteps as
            | string
            | null
        }
        initialExpectedResult={
          (node as unknown as Record<string, unknown>).expectedResult as
            | string
            | null
        }
        initialRemark={
          (node as unknown as Record<string, unknown>).remark as string | null
        }
        initialType={node.type}
        initialCaseLevel={node.caseLevel ?? null}
        initialLinkedIds={linkedIds}
        initialOpLogs={opLogs}
        pickerCases={pickerCases.map((c) => ({
          id: c.id,
          caseNo: c.caseNo,
          title: c.title,
          folder: { name: c.folder.name },
        }))}
      />
      <p className="mt-6 text-center text-xs text-zinc-400">
        <Link href="/test-cases" className="hover:underline">
          前往测试用例库
        </Link>
      </p>
    </div>
  );
}
