/**
 * 요청한 쪽 IP(속도 제한·기록용). 요청한 쪽이 직접 넣을 수 있는 헤더는 믿지 않는다.
 *
 * - Vercel(VERCEL=1): 플랫폼이 x-vercel-forwarded-for 와 x-forwarded-for 를 직접 채우고, 요청에 들어온 같은 이름의 헤더는 덮어쓴다.
 *   그래서 x-vercel-forwarded-for → x-forwarded-for 의 첫 값 순서로 쓴다.
 *   (https://vercel.com/docs/headers/request-headers — x-forwarded-for: "Vercel overwrites this header to prevent IP spoofing")
 *   x-real-ip 는 Vercel 이 아닌 곳에서는 요청한 쪽이 꾸밀 수 있어 마지막에만 본다.
 * - 그 밖(로컬·직접 올린 서버): x-forwarded-for 의 마지막 값(가장 가까운 프록시가 붙인 값)만 쓴다.
 *   x-real-ip 는 앞단 프록시가 덮어쓴다는 보장이 없어 쓰지 않는다. 프록시를 두면 x-forwarded-for 를 붙이도록 설정한다.
 */
export function clientIp(headers: Headers): string | null {
  const first = (value: string | null) => value?.split(",")[0]?.trim().slice(0, 64) || null;
  const chain = headers.get("x-forwarded-for")?.split(",").map((v) => v.trim()).filter(Boolean) ?? [];

  if (process.env.VERCEL === "1") {
    return first(headers.get("x-vercel-forwarded-for")) ?? (chain[0]?.slice(0, 64) || null) ?? first(headers.get("x-real-ip"));
  }

  return chain.length ? chain[chain.length - 1].slice(0, 64) : null;
}
