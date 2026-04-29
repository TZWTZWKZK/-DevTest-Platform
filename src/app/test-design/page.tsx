import { Suspense } from "react";
import { listIterationCodeOptions } from "@/app/actions/iterations";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { TestDesignTreeClient } from "@/components/TestDesignTreeClient";

function firstQuery(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

export default async function TestDesignPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const iterations = await listIterationCodeOptions();
  const sp = await searchParams;
  const icRaw = firstQuery(sp.iterationCode).trim();
  const rqRaw = firstQuery(sp.requirementId).trim();
  const validCodes = new Set(iterations.map((it) => it.code));
  const initialIterationCode =
    icRaw && validCodes.has(icRaw) ? icRaw : "";
  const initialRequirementId = rqRaw;

  return (
    <div className="p-8">
      <ModulePageHeader
        title="测试设计"
        description="按需求维护树形测试设计；节点可进入详情并关联测试用例库中的用例。"
      />
      <Suspense
        fallback={<p className="text-sm text-zinc-500">加载测试设计…</p>}
      >
        <TestDesignTreeClient
          iterations={iterations}
          initialIterationCode={initialIterationCode}
          initialRequirementId={initialRequirementId}
        />
      </Suspense>
    </div>
  );
}
