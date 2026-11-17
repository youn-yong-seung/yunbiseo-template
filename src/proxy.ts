import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 모든 요청 앞에서 도는 관문(Next.js 16 의 proxy, 예전 이름 middleware).
 * src/app 구조에서는 이 파일이 반드시 src/ 아래에 있어야 실행된다
 * (예전에는 저장소 루트에 있어서 아예 실행되지 않았다).
 *
 * - 세션 쿠키를 갱신한다(API 포함).
 * - 로그인하지 않은 사람이 화면(/dashboard 등)에 오면 서버에서 로그인 화면으로 보낸다.
 *   쿠키가 있다는 사실만으로 통과시키지 않는다(가짜 쿠키로 통과하던 문제).
 * - API 는 여기서 막지 않는다. 각 API 가 스스로 로그인·API 키·권한을 확인한다.
 */
const PUBLIC_PATHS = ["/login", "/auth"];

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  let user = null;
  let authCallFailed = false;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
    if (result.error && isTransientAuthError(result.error)) {
      authCallFailed = true;
    }
  } catch {
    authCallFailed = true;
  }

  // API 라우트는 세션 갱신만 하고, 인증은 라우트가 직접 한다.
  if (pathname.startsWith("/api/")) {
    return supabaseResponse;
  }

  const isPublic = PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (!user && !isPublic) {
    if (authCallFailed) {
      // 인증 서버가 잠깐 응답하지 않을 때도 화면을 열어 주지 않는다(fail-closed).
      return new NextResponse("로그인 서버에 연결하지 못했습니다. 잠시 후 새로고침해 주세요.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
      });
    }
    // 로그인 후 원래 목적지(예: yb login 인증 화면)로 돌아올 수 있도록 returnTo 를 보존한다.
    const returnTo = pathname + request.nextUrl.search;
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("returnTo", returnTo);
    return redirectWithSupabaseCookies(url, supabaseResponse);
  }

  if (user && pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard/workspace";
    url.search = "";
    return redirectWithSupabaseCookies(url, supabaseResponse);
  }

  return supabaseResponse;
}

function redirectWithSupabaseCookies(url: URL, supabaseResponse: NextResponse) {
  const response = NextResponse.redirect(url);

  supabaseResponse.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie);
  });

  return response;
}

/** 일시적 장애(네트워크/5xx)인지 — 인증 실패와 구분 */
function isTransientAuthError(error: { message?: string; status?: number }): boolean {
  const msg = error.message?.toLowerCase() ?? "";
  if (msg.includes("fetch") || msg.includes("network") || msg.includes("timeout")) {
    return true;
  }
  if (error.status && error.status >= 500) return true;
  return false;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
