export const PENDING_TEST_DESIGN_IMPORT_STORAGE =
  "pm-pending-test-design-import";

const PENDING_TTL_MS = 86400000;

export type PendingTestDesignImport = {
  ids: string[];
  productId?: string;
  ts: number;
};

export function readPendingTestDesignImport(): PendingTestDesignImport | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
    if (!raw) return null;
    const j = JSON.parse(raw) as {
      ids?: unknown;
      productId?: unknown;
      ts?: number;
    };
    const ts = typeof j.ts === "number" ? j.ts : 0;
    if (Date.now() - ts > PENDING_TTL_MS) {
      sessionStorage.removeItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
      return null;
    }
    const ids = Array.isArray(j.ids)
      ? j.ids.filter(
          (x): x is string => typeof x === "string" && x.trim() !== "",
        )
      : [];
    if (ids.length === 0) return null;
    const productId =
      typeof j.productId === "string" && j.productId.trim()
        ? j.productId.trim()
        : undefined;
    return { ids, productId, ts };
  } catch {
    try {
      sessionStorage.removeItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function writePendingTestDesignImport(input: {
  ids: string[];
  productId?: string;
}): void {
  if (typeof window === "undefined") return;
  const ids = input.ids.filter((x) => x.trim() !== "");
  if (ids.length === 0) return;
  sessionStorage.setItem(
    PENDING_TEST_DESIGN_IMPORT_STORAGE,
    JSON.stringify({
      ids,
      productId: input.productId?.trim() || undefined,
      ts: Date.now(),
    }),
  );
}

export function clearPendingTestDesignImport(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(PENDING_TEST_DESIGN_IMPORT_STORAGE);
  } catch {
    /* ignore */
  }
}
