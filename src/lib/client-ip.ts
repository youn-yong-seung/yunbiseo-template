/**
 * 요청한 쪽 IP(속도 제한·기록용). 요청한 쪽이 직접 넣을 수 있는 헤더는 믿지 않는다.
 *
 * - Vercel(VERCEL=1): 플랫폼이 x-vercel-forwarded-for 와 x-forwarded-for 를 직접 채우고, 요청에 들어온 같은 이름의 헤더는 덮어쓴다.
 *   그래서 x-vercel-forwarded-for → x-forwarded-for 의 첫 값 순서로 쓴다.
 *   (https://vercel.com/docs/headers/request-headers — x-forwarded-for: "Vercel overwrites this header to prevent IP spoofing")
 *   x-real-ip 는 Vercel 이 아닌 곳에서는 요청한 쪽이 꾸밀 수 있어 마지막에만 본다.
 * - 그 밖(로컬·직접 올린 서버): TRUSTED_PROXY_HOPS(앞에 둔 믿을 수 있는 프록시 수)가 있을 때만 x-forwarded-for 를 쓴다.
 *   프록시는 받은 값 뒤에 자기가 본 주소를 붙이므로, 뒤에서 N번째 값이 바깥 프록시가 본 실제 접속 주소다.
 *   설정이 없으면(또는 0이면) x-forwarded-for 를 믿지 않고 null 을 돌려준다.
 *   (프록시 없이 `next start` 로 바로 열면 요청한 쪽이 x-forwarded-for 를 마음대로 넣을 수 있다.)
 *   IP 를 모를 때 쓰는 쪽(로그인 속도 제한 등)은 모두가 한 칸을 같이 쓰지 않도록 따로 처리한다.
 */
export function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 0;
  const hops = Number.parseInt(raw, 10);
  return Number.isFinite(hops) && hops > 0 && hops <= 10 ? hops : 0;
}

export function clientIp(headers: Headers): string | null {
  const first = (value: string | null) => value?.split(",")[0]?.trim().slice(0, 64) || null;
  const chain = headers.get("x-forwarded-for")?.split(",").map((v) => v.trim()).filter(Boolean) ?? [];

  if (process.env.VERCEL === "1") {
    return first(headers.get("x-vercel-forwarded-for")) ?? (chain[0]?.slice(0, 64) || null) ?? first(headers.get("x-real-ip"));
  }

  const hops = trustedProxyHops();
  if (hops === 0 || chain.length < hops) return null;
  return chain[chain.length - hops].slice(0, 64) || null;
}
