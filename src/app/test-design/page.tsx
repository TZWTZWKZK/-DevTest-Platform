import { Suspense } from "react";
import { listIterationCodeOptions } from "@/app/actions/iterations";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { TestDesignTreeClient } from "@/components/TestDesignTreeClient";

export default async function TestDesignPage() {
  const iterations = await listIterationCodeOptions();
  return (
    <div className="p-8">
      <ModulePageHeader
        title="测试设计"
        description="按需求维护树形测试设计；节点可进入详情并关联测试用例库中的用例。"
      />
      <Suspense
        fallback={<p className="text-sm text-zinc-500">加载测试设计…</p>}
      >
        <TestDesignTreeClient iterations={iterations} />
      </Suspense>
    </div>
  );
}
