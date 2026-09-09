/**
 * Node 预加载入口：须在 Next / Prisma 之前执行（package.json / nodemon 使用 node -r ./skywalking.cjs）。
 * 配置集中在 config/skywalking.local.cjs（git 忽略）。
 */
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "config", "skywalking.local.cjs");

if (!fs.existsSync(configPath)) {
  console.warn(
    "[skywalking] 未找到 config/skywalking.local.cjs，探针未启动。请复制 config/skywalking.example.cjs",
  );
  return;
}

/** @type {import('./config/skywalking.example.cjs')} */
const config = require(configPath);

if (!config.enabled) {
  return;
}

if (config.traceIgnorePath) {
  process.env.SW_TRACE_IGNORE_PATH = config.traceIgnorePath;
}

const agent = require("skywalking-backend-js").default;

const startOptions = {
  serviceName: config.serviceName || "product-management",
  collectorAddress: config.collectorAddress || "127.0.0.1:41800",
};

if (config.serviceInstance) {
  startOptions.serviceInstance = config.serviceInstance;
}
if (config.authorization) {
  startOptions.authorization = config.authorization;
}

agent.start(startOptions);
