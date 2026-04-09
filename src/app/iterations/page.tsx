import { listProductOptions } from "@/app/actions/iterations";
import { ModulePageHeader } from "@/components/PageModuleLayout";
import { IterationManagementClient } from "@/components/IterationManagementClient";

export default async function IterationsPage({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string; iterationId?: string }>;
}) {
  const sp = await searchParams;
  const products = await listProductOptions();
  /** 查询串变化时强制重挂客户端，避免沿用到「默认第一项」的 productId 状态 */
  const iterClientKey = [
    sp.productId?.trim() ?? "",
    sp.iterationId?.trim() ?? "",
  ].join("|");
  return (
    <div className="p-8">
      <ModulePageHeader
        title="迭代管理"
        description="新建迭代前通过下拉框选择产品；切换产品仅展示该产品下的迭代数据。"
      />
      <IterationManagementClient
        key={iterClientKey}
        initialProducts={products}
        initialProductId={sp.productId}
        initialIterationId={sp.iterationId}
      />
    </div>
  );
}
