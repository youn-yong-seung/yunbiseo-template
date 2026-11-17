import type { NextConfig } from "next";

// 모든 응답에 붙이는 기본 보안 헤더.
// - 다른 사이트가 윤비서 화면을 iframe 으로 감싸 클릭을 유도하지 못하게(frame-ancestors / X-Frame-Options)
// - 파일 형식 추측 금지, 다른 사이트로 주소 전체를 넘기지 않기
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
