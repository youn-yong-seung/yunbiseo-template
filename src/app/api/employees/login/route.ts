import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logError, logInfo } from "@/lib/logger";

/**
 * 로그인. 비밀번호 확인과 시도 제한을 모두 서버에서 한다.
 *
 * - 대상 계정은 "인증 이메일이 정확히 일치하는 직원"이다(아이디 → 이메일로 바꾼 뒤 auth.users 와 비교).
 *   직원이 자기 아이디를 남의 이메일처럼 바꿔도 남의 실패 횟수에 영향을 주지 못한다.
 * - 시도 예약(reserve_login_attempt): Supabase 에 비밀번호를 보내기 전에 DB 행 잠금으로 시도를 센다.
 *   10분 안에 5번까지만 보내고, 5번 실패하면 15분 잠근다(동시에 여러 번 보내도 5번을 넘지 않는다).
 * - 앱 쪽 속도 제한(check_login_rate): 접속 IP 별·아이디 별 5분 10번.
 * - 실패 응답은 모두 같다(없는 아이디·틀린 비밀번호·잠김·비활성·직원 아닌 계정).
 * - (선택) Turnstile: NEXT_PUBLIC_TURNSTILE_SITE_KEY 가 있으면 보안 확인 토큰을 Supabase 에 넘긴다(SETUP.md 3-3).
 *
 * POST { login_id, password, captcha_token? } → 성공 시 세션 쿠키를 심고 { success: true }
 */
const GENERIC_FAILURE =
  "로그인 ID 또는 비밀번호가 올바르지 않습니다. 5번 틀리면 15분 동안 로그인할 수 없고, 그래도 안 되면 관리자에게 문의하세요.";
const AUTH_EMAIL_DOMAIN = (process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com").toLowerCase();
const CAPTCHA_ENABLED = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

function toAuthEmail(loginId: string): string {
  const value = loginId.trim().toLowerCase();
  return value.includes("@") ? value : `${value}@${AUTH_EMAIL_DOMAIN}`;
}

function failure() {
  return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const loginId = typeof body?.login_id === "string" ? body.login_id.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const captchaToken = typeof body?.captcha_token === "string" ? body.captcha_token.slice(0, 4096) : "";

    if (!loginId || !password || loginId.length > 200 || password.length > 200) {
      return NextResponse.json({ error: "로그인 ID와 비밀번호를 입력해 주세요." }, { status: 400 });
    }
    if (CAPTCHA_ENABLED && !captchaToken) {
      return NextResponse.json({ error: "보안 확인을 마친 뒤 다시 로그인해 주세요." }, { status: 400 });
    }

    const admin = createAdminClient();
    const email = toAuthEmail(loginId);

    // 앱 쪽 속도 제한(아이디·IP 별). 계정 존재와 무관하게 같은 기준으로 센다.
    const { data: rateOk } = await admin.rpc("check_login_rate", {
      p_ip: clientIp(request.headers) ?? "unknown",
      p_login_key: email,
    });
    if (rateOk === false) {
      return NextResponse.json({ error: "로그인 시도가 너무 많습니다. 5분 뒤 다시 시도해 주세요." }, { status: 429 });
    }

    const { data: rows } = await admin.rpc("employee_by_auth_email", { p_email: email });
    const employee = (Array.isArray(rows) ? rows[0] : null) as { id: string; login_id: string | null } | null;

    // 비밀번호를 보내기 전에 시도를 예약한다. 잠겼거나 이번 창의 5번을 다 썼으면 확인하지 않는다.
    if (employee) {
      const { data: reserved } = await admin.rpc("reserve_login_attempt", { p_employee_id: employee.id });
      if (reserved !== true) return failure();
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
      ...(captchaToken ? { options: { captchaToken } } : {}),
    });

    if (error || !data.user) {
      if (employee) {
        const { data: count } = await admin.rpc("record_login_failure", { p_employee_id: employee.id });
        logError("LOGIN_FAILED", `로그인 실패: ${employee.login_id ?? ""}`, {
          resource: "employee",
          resource_id: employee.id,
          details: { failed_count: typeof count === "number" ? count : null },
        });
      }
      return failure();
    }

    // 비밀번호는 맞지만 직원이 아니거나(회원가입 계정) 비활성이면 들이지 않는다. 응답은 같은 실패.
    const { data: linked } = await admin
      .from("employees")
      .select("id, is_active, login_id")
      .eq("auth_uid", data.user.id)
      .maybeSingle();
    if (!linked || linked.is_active !== true) {
      await supabase.auth.signOut();
      return failure();
    }

    await admin
      .from("employees")
      .update({
        failed_login_count: 0,
        failed_login_window_started_at: null,
        last_failed_login_at: null,
        login_locked_until: null,
        last_login_at: new Date().toISOString(),
      })
      .eq("id", linked.id);

    logInfo("LOGIN_SUCCESS", `로그인 성공: ${linked.login_id ?? ""}`, {
      resource: "employee",
      resource_id: linked.id as string,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[login]", error instanceof Error ? error.message : error);
    return failure();
  }
}
