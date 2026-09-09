"use client";

import { Suspense, useState } from "react";
import type { TestDesignType } from "@prisma/client";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { TestDesignTreeClient } from "@/components/TestDesignTreeClient";

export function TestDesignPageClient({
  iterations,
  initialProductId,
  initialIterationCode,
  initialRequirementId,
  initialCategory,
  initialDirId,
}: {
  iterations: { code: string; label: string; productId?: string | null }[];
  initialProductId: string;
  initialIterationCode: string;
  initialRequirementId: string;
  initialCategory: TestDesignType | "";
  initialDirId: string;
}) {
  const [immersive, setImmersive] = useState(false);

  return (
    <div
      className={[
        "box-border flex h-[100dvh] flex-col overflow-hidden",
        immersive ? "p-4" : "p-8",
      ].join(" ")}
    >
      {!immersive ? (
        <div className="shrink-0">
          <ModulePageHeader
            title="测试设计"
            description="按需求维护树形测试设计；节点可进入详情并关联测试用例库中的用例。"
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={<p className="text-sm text-zinc-500">加载测试设计…</p>}
        >
          <TestDesignTreeClient
            iterations={iterations}
            initialProductId={initialProductId}
            initialIterationCode={initialIterationCode}
            initialRequirementId={initialRequirementId}
            initialCategory={initialCategory}
            initialDirId={initialDirId}
            onImmersiveLayoutChange={setImmersive}
          />
        </Suspense>
      </div>
    </div>
  );
}
