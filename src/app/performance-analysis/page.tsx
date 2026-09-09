import { ModulePageHeader } from "@/components/PageModuleLayout";
import { PerformanceAnalysisClient } from "@/components/PerformanceAnalysisClient";

export default function PerformanceAnalysisPage() {
  return (
    <div className="p-8">
      <ModulePageHeader
        title="性能分析"
        description="选择压测根目录后先扫描各子节点第一层的 summary.csv，确认后再仅读取这些文件并汇总报告（不上传 exchanges 等其它文件）。"
      />
      <PerformanceAnalysisClient />
    </div>
  );
}
