import { createBrowserClient } from "@supabase/ssr";

function instantiate() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // 브라우저 런타임에서 env 가 비어 있으면 설정 문제이므로 명확한 안내와 함께 실패시킨다.
    if (typeof window !== "undefined") {
      throw new Error(
        "Supabase 환경변수(NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)가 없습니다. .env.local 을 설정한 뒤 다시 빌드/실행하세요."
      );
    }
    // 빌드 프리렌더(SSR) 단계에서는 클라이언트가 실제 네트워크 요청을 하지 않으므로
    // placeholder 로 대체해 env 없이도 `npm run build` 가 통과하도록 한다.
    return createBrowserClient(
      "https://placeholder.supabase.co",
      "sb_publishable_placeholder"
    );
  }

  return createBrowserClient(url, anonKey);
}

let browserClientSingleton: ReturnType<typeof instantiate> | null = null;

// 브라우저에서 매 페이지 마운트마다 새 클라이언트를 만들면 이전 인스턴스의 auto-refresh 타이머와
// onAuthStateChange 구독이 그대로 살아 있어 navigator.lock 을 점유한다. 다음 페이지의
// getSession() 워밍업이 이 락 해제를 기다리면서 "로딩중" 이 길게 노출되는 현상이 발생한다.
// 브라우저에서는 항상 같은 인스턴스를 재사용해 락 경합과 메모리 누수를 차단한다.
export function createClient() {
  if (typeof window === "undefined") {
    return instantiate();
  }
  if (!browserClientSingleton) {
    browserClientSingleton = instantiate();
  }
  return browserClientSingleton;
}

export async function clearClientSession() {
  const supabase = createClient();
  await supabase.auth.signOut();
}

// fetchData 시작 시점에 호출하는 세션 워밍업.
// 모바일 백그라운드 복귀 직후 JWT refresh 경합을 방지하기 위해 도입했지만,
// navigator.lock 이 다른 호출에 점유돼 있으면 무기한 대기할 수 있다.
// 짧은 타임아웃을 둬서 워밍업이 막혀도 페이지 로딩이 멈추지 않도록 한다.
export async function warmupSession(
  supabase: ReturnType<typeof createClient>,
  timeoutMs = 1500
): Promise<void> {
  try {
    await Promise.race([
      supabase.auth.getSession(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // 세션 조회 실패는 무시 — 후속 쿼리에서 쿠키 기반 인증이 처리한다.
  }
}
