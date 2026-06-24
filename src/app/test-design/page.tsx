import type { TestDesignType } from "@prisma/client";
import { listIterationCodeOptions } from "@/app/actions/iterations";
import { listProductOptions } from "@/app/actions/products";
import { TestDesignPageClient } from "@/components/TestDesignPageClient";
import { testDesignTypeOptions } from "@/lib/test-labels";

const TEST_DESIGN_TYPES = new Set(
  testDesignTypeOptions.map((o) => o.value as TestDesignType),
);

function parseDesignType(v: string): TestDesignType | "" {
  const t = v.trim() as TestDesignType;
  return TEST_DESIGN_TYPES.has(t) ? t : "";
}

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
  const [iterations, products] = await Promise.all([
    listIterationCodeOptions(),
    listProductOptions(),
  ]);
  const sp = await searchParams;
  const icRaw = firstQuery(sp.iterationCode).trim();
  const rqRaw = firstQuery(sp.requirementId).trim();
  const pidRaw = firstQuery(sp.productId).trim();
  const validCodes = new Set(iterations.map((it) => it.code));
  const validProductIds = new Set(products.map((p) => p.id));
  const initialIterationCode =
    icRaw && validCodes.has(icRaw) ? icRaw : "";
  const initialRequirementId = rqRaw;
  const initialProductId =
    pidRaw && validProductIds.has(pidRaw) ? pidRaw : "";
  const initialCategory = parseDesignType(firstQuery(sp.type));
  const initialDirId = firstQuery(sp.dirId).trim();

  return (
    <TestDesignPageClient
      iterations={iterations}
      initialProductId={initialProductId}
      initialIterationCode={initialIterationCode}
      initialRequirementId={initialRequirementId}
      initialCategory={initialCategory}
      initialDirId={initialDirId}
    />
  );
}
