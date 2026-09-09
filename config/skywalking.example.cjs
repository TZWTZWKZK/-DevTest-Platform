/**
 * SkyWalking 探针配置模板。
 * 复制为 skywalking.local.cjs 后按需修改（该文件已加入 .gitignore，不会提交到 Git）。
 *
 * @see https://github.com/apache/skywalking-nodejs
 */
module.exports = {
  /** 设为 false 可本地关闭探针而不改启动命令 */
  enabled: true,

  serviceName: "product-management",

  /** 多实例部署时可区分实例，留空则由探针随机生成 */
  serviceInstance: undefined,

  /** SkyWalking OAP gRPC 地址 */
  collectorAddress: "127.0.0.1:41800",

  /** OAP 开启 agent 认证时填写 */
  // authorization: "",

  /** 逗号分隔，不采集的路径前缀 */
  // traceIgnorePath: "/favicon.ico,/_next",
};
