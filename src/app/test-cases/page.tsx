import { Suspense } from "react";
import { listFoldersFlat } from "@/app/actions/test-cases";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { TestCaseLibraryClient } from "@/components/TestCaseLibraryClient";

export default async function TestCasesPage() {
  const folders = await listFoldersFlat();
  return (
    <div className="p-8">
      <ModulePageHeader
        title="测试用例库"
        description="列表展示当前选中目录及其全部子目录下的用例；新建用例时记录创建时间，后续修改不会改变创建时间。"
      />
      <Suspense
        fallback={<p className="text-sm text-zinc-500">加载用例库…</p>}
      >
        <TestCaseLibraryClient initialFolders={folders} />
      </Suspense>
    </div>
  );
}
