import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // 缺陷截屏、需求附件（base64）等可能较大；单附件上限 10MB 时 Data URL 约 13MB+
      bodySizeLimit: "16mb",
    },
  },
};

export default nextConfig;
