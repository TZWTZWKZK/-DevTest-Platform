import { prisma } from "@/lib/prisma";
import {
  ProductManagement,
  type PrimaryProjectOption,
  type ProductRow,
} from "@/components/ProductManagement";

function parentLabel(
  parent: { name: string; code: string | null } | undefined,
): string | null {
  if (!parent) return null;
  const c = parent.code ?? "无编码";
  return `${parent.name}（${c}）`;
}

export default async function HomePage() {
  const rows = await prisma.product.findMany({
    orderBy: { updatedAt: "desc" },
    include: {
      _count: { select: { iterations: true } },
    },
  });

  const parentIds = [
    ...new Set(
      rows.map((r) => r.parentId).filter((id): id is string => Boolean(id)),
    ),
  ];

  const parents =
    parentIds.length === 0
      ? []
      : await prisma.product.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, name: true, code: true },
        });

  const parentById = new Map(parents.map((p) => [p.id, p]));

  const primaryRows = await prisma.product.findMany({
    where: { level: 1 },
    orderBy: { name: "asc" },
    select: { id: true, name: true, code: true },
  });

  const primaryProjectOptions: PrimaryProjectOption[] = primaryRows.map(
    (p) => ({
      id: p.id,
      name: p.name,
      code: p.code,
    }),
  );

  const initialProducts: ProductRow[] = rows.map((p) => ({
    id: p.id,
    name: p.name,
    code: p.code,
    isBaseline: p.isBaseline,
    level: p.level,
    parentId: p.parentId,
    parentLabel: parentLabel(
      p.parentId ? parentById.get(p.parentId) : undefined,
    ),
    owner: p.owner,
    department: p.department,
    teamMembers: p.teamMembers,
    startDate: p.startDate?.toISOString() ?? null,
    endDate: p.endDate?.toISOString() ?? null,
    description: p.description,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    iterationCount: p._count.iterations,
  }));

  return (
    <ProductManagement
      initialProducts={initialProducts}
      primaryProjectOptions={primaryProjectOptions}
    />
  );
}
