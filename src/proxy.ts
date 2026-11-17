import { createServerClient } from "@supabase/ssr";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";

/**
 * 모든 요청 앞에서 도는 관문(Next.js 16 의 proxy, 예전 이름 middleware).
 * src/app 구조에서는 이 파일이 반드시 src/ 아래에 있어야 실행된다
 * (예전에는 저장소 루트에 있어서 아예 실행되지 않았다).
 *
 * - 세션 쿠키를 갱신한다(API 포함).
 * - 로그인하지 않은 사람이 화면(/dashboard 등)에 오면 서버에서 로그인 화면으로 보낸다.
 *   쿠키가 있다는 사실만으로 통과시키지 않는다(가짜 쿠키로 통과하던 문제).
 * - 로그인은 했지만 직원이 아니거나 비활성인 계정(Supabase 회원가입 계정 등)은 화면 껍데기도 열지 않는다.
 * - /dashboard·/cli-auth 아래는 주소가 .png 처럼 끝나도 똑같이 막는다.
 * - API 는 여기서 막지 않는다. 각 API 가 스스로 로그인·API 키·권한을 확인한다.
 */
const PUBLIC_PATHS = ["/login", "/auth"];
const PROTECTED_PREFIXES = ["/dashboard", "/cli-auth"];
const STATIC_FILE_RE = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|webmanifest|json)$/i;

function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** 로그인 사용자가 활성 직원인지(서버 전용 키로 확인, RLS 와 무관). */
async function isActiveEmployee(authUid: string): Promise<boolean | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const admin = createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { data, error } = await admin
      .from("employees")
      .select("id")
      .eq("auth_uid", authUid)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (error) return null;
    return Boolean(data);
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // public/ 의 정적 파일(로고 등)은 그대로 보낸다. 보호 경로 아래는 확장자가 있어도 아래 검사를 거친다.
  if (!isProtectedPath(pathname) && STATIC_FILE_RE.test(pathname)) {
    return NextResponse.next();
  }

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

  // 로그인은 했지만 활성 직원이 아니면 화면을 열지 않는다(로그인 화면으로 보내고 세션을 끊는다).
  if (user && !isPublic) {
    const active = await isActiveEmployee(user.id);
    if (active === null) {
      return new NextResponse("로그인 서버에 연결하지 못했습니다. 잠시 후 새로고침해 주세요.", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
      });
    }
    if (!active) {
      await supabase.auth.signOut();
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      return redirectWithSupabaseCookies(url, supabaseResponse);
    }
  }

  if (user && pathname.startsWith("/login") && (await isActiveEmployee(user.id)) === true) {
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
    // 확장자 경로도 모두 거친다(정적 파일은 위에서 바로 통과). _next 빌드 파일만 뺀다.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
