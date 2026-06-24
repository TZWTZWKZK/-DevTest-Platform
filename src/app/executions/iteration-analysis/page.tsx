import {
  listIterationAnalysisReports,
} from "@/app/actions/iteration-analysis";
import { listProductOptions } from "@/app/actions/products";
import { IterationAnalysisClient } from "@/components/IterationAnalysisClient";
import { IterationAnalysisListClient } from "@/components/IterationAnalysisListClient";
import { ModulePageHeader } from "@/components/PageModuleLayout";

export default async function IterationAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{
    edit?: string;
    productId?: string;
    iterationId?: string;
  }>;
}) {
  const sp = await searchParams;
  const products = await listProductOptions();
  const productId = sp.productId?.trim() ?? "";
  const filterIterationId = sp.iterationId?.trim() ?? "";
  const editId = sp.edit?.trim() ?? "";

  if (editId) {
    const editProductId =
      productId ||
      (
        await listIterationAnalysisReports({
          iterationId: editId,
        })
      )[0]?.productId ||
      "";

    return (
      <div className="p-8">
        <ModulePageHeader
          title="迭代分析 · 编辑"
          description="填写简言、研发流程优化、工具改进与质量提升；支持子栏目、文件上传与 HTML 预览，内容自动保存。"
        />
        <IterationAnalysisClient
          key={`${editId}:${editProductId}`}
          products={products}
          initialProductId={editProductId}
          initialIterationId={editId}
        />
      </div>
    );
  }

  const list = await listIterationAnalysisReports({
    productId: productId || null,
    iterationId: filterIterationId || null,
  });

  return (
    <div className="p-8">
      <ModulePageHeader
        title="迭代分析"
        description="按产品/迭代筛选查看各迭代分析报告列表；点击「编辑/新建」进入详情填写。"
      />
      <IterationAnalysisListClient
        key={`${productId}:${filterIterationId}`}
        initialRows={list}
        products={products}
        initialProductId={productId}
        initialIterationId={filterIterationId}
      />
    </div>
  );
}
