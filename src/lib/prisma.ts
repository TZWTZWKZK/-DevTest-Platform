import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function makePrisma() {
  return new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });
}

/**
 * 开发环境下 Turbopack/HMR 可能保留「生成于 prisma generate 之前」的单例，
 * 其上不存在新模型的 delegate（如 testCaseFolder），会报 undefined.findMany。
 * 检测到后断开并换新实例。
 */
const cached = globalForPrisma.prisma;
if (
  cached &&
  (typeof (cached as unknown as { testCaseFolder?: unknown }).testCaseFolder ===
    "undefined" ||
    typeof (cached as unknown as { defectTestCase?: unknown }).defectTestCase ===
      "undefined")
) {
  void cached.$disconnect();
  globalForPrisma.prisma = undefined;
}

export const prisma = globalForPrisma.prisma ?? makePrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
