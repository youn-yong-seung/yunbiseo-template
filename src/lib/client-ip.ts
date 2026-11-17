/**
 * 요청한 쪽 IP. 배포 플랫폼이 직접 붙이는 헤더를 먼저 믿는다(요청한 쪽이 x-forwarded-for 첫 값을 꾸밀 수 있다).
 * Vercel: x-vercel-forwarded-for / x-real-ip. 그 밖에는 x-forwarded-for 의 마지막 값(가장 가까운 프록시가 붙인 값).
 */
export function clientIp(headers: Headers): string | null {
  const platform = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (platform) return platform.split(",")[0]?.trim().slice(0, 64) || null;
  const chain = headers.get("x-forwarded-for")?.split(",").map((v) => v.trim()).filter(Boolean) ?? [];
  return chain.length ? chain[chain.length - 1].slice(0, 64) : null;
}
