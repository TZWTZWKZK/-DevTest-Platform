import { ModulePageHeader } from "@/components/PageModuleLayout";
import { DefectAnalysisClient } from "@/components/DefectAnalysisClient";

export default function DefectAnalysisPage() {
  return (
    <div className="p-8">
      <ModulePageHeader
        title="缺陷分析"
        description="上传含 bug简述、同类缺陷个数、缺陷类型、缺陷总结的 Excel，查看按类型汇总的扇形统计图，并展开查看各类型下的 bug 简述；支持导出分析报告。"
      />
      <DefectAnalysisClient />
    </div>
  );
}
