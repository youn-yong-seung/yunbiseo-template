import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logError, logInfo } from "@/lib/logger";

const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MINUTES = 10;
const ATTEMPT_WINDOW_MS = ATTEMPT_WINDOW_MINUTES * 60 * 1000;
// 5번 틀리면 15분 동안 잠근다. 예전처럼 계정을 비활성화하지 않는다
// (누군가 관리자 ID 로 일부러 틀려서 관리자를 영구히 잠그는 것을 막기 위해).
const LOCK_MINUTES = 15;
const LOCK_MS = LOCK_MINUTES * 60 * 1000;
const GENERIC_FAILURE = "로그인 ID 또는 비밀번호가 올바르지 않습니다.";

type EmployeeLoginRow = {
  id: string;
  name: string | null;
  login_id: string | null;
  is_active: boolean | null;
  failed_login_count: number | null;
  failed_login_window_started_at: string | null;
  last_failed_login_at: string | null;
  last_login_at: string | null;
};

function normalizeLoginId(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

const AUTH_EMAIL_DOMAIN = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com";

function toAuthEmail(loginId: string): string {
  return loginId.includes("@") ? loginId : `${loginId}@${AUTH_EMAIL_DOMAIN}`;
}

async function findEmployeeByLoginId(loginId: string): Promise<EmployeeLoginRow | null> {
  const supabase = createAdminClient();
  const authEmail = toAuthEmail(loginId);
  const loginBase = loginId.includes("@") ? loginId.split("@")[0] : loginId;

  const candidates = Array.from(
    new Set([loginId, authEmail, loginBase].map((v) => v.trim()).filter(Boolean))
  );

  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from("employees")
      .select(
        "id, name, login_id, is_active, failed_login_count, failed_login_window_started_at, last_failed_login_at, last_login_at"
      )
      .eq("login_id", candidate)
      .maybeSingle();

    if (error) {
      throw new Error(error.message);
    }

    if (data) {
      return data as EmployeeLoginRow;
    }
  }

  return null;
}

function isLocked(employee: EmployeeLoginRow, now: Date) {
  const count = employee.failed_login_count ?? 0;
  const last = employee.last_failed_login_at ? new Date(employee.last_failed_login_at).getTime() : 0;
  return count >= MAX_FAILED_ATTEMPTS && now.getTime() - last < LOCK_MS;
}

async function recordFailure(employee: EmployeeLoginRow, now: Date) {
  const windowStartedAt = employee.failed_login_window_started_at
    ? new Date(employee.failed_login_window_started_at)
    : null;
  const isWithinWindow =
    windowStartedAt && now.getTime() - windowStartedAt.getTime() <= ATTEMPT_WINDOW_MS;
  const nextCount = isWithinWindow ? (employee.failed_login_count ?? 0) + 1 : 1;

  await createAdminClient()
    .from("employees")
    .update({
      failed_login_count: nextCount,
      failed_login_window_started_at: isWithinWindow
        ? (windowStartedAt as Date).toISOString()
        : now.toISOString(),
      last_failed_login_at: now.toISOString(),
    })
    .eq("id", employee.id);

  logError("LOGIN_FAILED", `로그인 실패: ${employee.login_id ?? ""}`, {
    resource: "employee",
    resource_id: employee.id,
    details: { failed_count: nextCount },
  });

  return Math.max(0, MAX_FAILED_ATTEMPTS - nextCount);
}

/**
 * 로그인. 비밀번호 확인과 실패 횟수 기록을 모두 서버에서 한다.
 * (예전에는 브라우저가 "실패했다/성공했다"를 알려 줘서, 남이 실패를 꾸며 계정을 잠그거나
 *  성공을 꾸며 잠금을 풀 수 있었다.)
 *
 * POST { login_id, password } → 성공 시 세션 쿠키를 심고 { success: true }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const loginId = normalizeLoginId(body?.login_id);
    const password = typeof body?.password === "string" ? body.password : "";

    if (!loginId || !password || loginId.length > 200 || password.length > 200) {
      return NextResponse.json({ error: "로그인 ID와 비밀번호를 입력해 주세요." }, { status: 400 });
    }

    const now = new Date();
    const employee = await findEmployeeByLoginId(loginId);

    if (employee && employee.is_active === false) {
      return NextResponse.json(
        { error: "계정이 비활성화되었습니다. 관리자에게 문의하세요.", blocked: true },
        { status: 403 }
      );
    }

    if (employee && isLocked(employee, now)) {
      return NextResponse.json(
        { error: `비밀번호를 ${MAX_FAILED_ATTEMPTS}번 틀려 ${LOCK_MINUTES}분 동안 로그인할 수 없습니다. 잠시 후 다시 시도하세요.`, locked: true },
        { status: 429 }
      );
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: toAuthEmail(employee?.login_id || loginId),
      password,
    });

    if (error || !data.user) {
      if (employee) {
        const remaining = await recordFailure(employee, now);
        return NextResponse.json(
          {
            error: remaining > 0 ? `${GENERIC_FAILURE} (${remaining}회 남음)` : GENERIC_FAILURE,
            remaining_attempts: remaining,
          },
          { status: 401 }
        );
      }
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
    }

    // 비밀번호는 맞지만 직원으로 등록되지 않은 계정(예: Supabase 회원가입으로 만든 계정)은 들이지 않는다.
    const admin = createAdminClient();
    const { data: linked } = await admin
      .from("employees")
      .select("id, is_active")
      .eq("auth_uid", data.user.id)
      .maybeSingle();
    if (!linked || linked.is_active !== true) {
      await supabase.auth.signOut();
      return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
    }

    await admin
      .from("employees")
      .update({
        failed_login_count: 0,
        failed_login_window_started_at: null,
        last_failed_login_at: null,
        last_login_at: now.toISOString(),
      })
      .eq("id", linked.id);

    logInfo("LOGIN_SUCCESS", `로그인 성공: ${employee?.login_id ?? loginId}`, {
      resource: "employee",
      resource_id: linked.id as string,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[login]", error);
    return NextResponse.json({ error: "로그인 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
