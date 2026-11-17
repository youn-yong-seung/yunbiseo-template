/**
 * 알림(슬랙 등)에 넣을 윤비서 주소. 요청 본문이나 Origin 헤더(조작 가능)는 쓰지 않는다.
 * NEXT_PUBLIC_APP_URL 이 있으면 그 값을, 없으면 이 요청을 받은 서버 주소를 쓴다.
 */
export function appBaseUrl(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // 잘못된 설정이면 아래로
    }
  }
  return new URL(request.url).origin;
}

export function appUrl(request: Request, path: string): string {
  return `${appBaseUrl(request)}${path.startsWith("/") ? path : `/${path}`}`;
}
