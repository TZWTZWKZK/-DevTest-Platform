import { ModulePageHeader } from "@/components/PageModuleLayout";
import { DefectManagementClient } from "@/components/DefectManagementClient";

export default function DefectsPage() {
  return (
    <div className="p-8">
      <ModulePageHeader
        title="缺陷管理"
        description="维护缺陷列表；支持高级筛选与批量删除。"
      />
      <DefectManagementClient />
    </div>
  );
}
