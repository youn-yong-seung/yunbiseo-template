import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logError, logInfo } from "@/lib/logger";

/**
 * 로그인. 비밀번호 확인과 실패 횟수 기록을 모두 서버에서 한다.
 *
 * - 아이디는 대소문자를 구분하지 않고 찾는다(QA-STAFF 와 qa-staff 는 같은 계정, 실패 횟수도 같이 센다).
 * - 실패 횟수는 DB 함수 record_login_failure 가 UPDATE 한 번으로 올린다(동시 요청에도 빠짐없이 센다).
 * - 10분 안에 5번 틀리면 15분 동안 잠근다(계정을 비활성화하지는 않는다).
 * - 실패 응답은 모두 같다: 없는 아이디·틀린 비밀번호·잠김·비활성·직원 아닌 계정을 응답으로 구분할 수 없다.
 * - Supabase 로 직접 비밀번호 로그인하는 길은 토큰 발급 훅(custom_access_token_hook)이 잠김·비직원을 막는다.
 *
 * POST { login_id, password } → 성공 시 세션 쿠키를 심고 { success: true }
 */
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const GENERIC_FAILURE =
  "로그인 ID 또는 비밀번호가 올바르지 않습니다. 5번 틀리면 15분 동안 로그인할 수 없고, 그래도 안 되면 관리자에게 문의하세요.";

type EmployeeLoginRow = {
  id: string;
  login_id: string | null;
  auth_uid: string | null;
  is_active: boolean | null;
  failed_login_count: number | null;
  last_failed_login_at: string | null;
};

const AUTH_EMAIL_DOMAIN = process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com";

function toAuthEmail(loginId: string): string {
  const value = loginId.toLowerCase();
  return value.includes("@") ? value : `${value}@${AUTH_EMAIL_DOMAIN}`;
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function findEmployeeByLoginId(loginId: string): Promise<EmployeeLoginRow | null> {
  const supabase = createAdminClient();
  const base = loginId.includes("@") ? loginId.split("@")[0] : loginId;
  const candidates = Array.from(new Set([loginId, base].map((v) => v.trim()).filter(Boolean)));

  for (const candidate of candidates) {
    const { data, error } = await supabase
      .from("employees")
      .select("id, login_id, auth_uid, is_active, failed_login_count, last_failed_login_at")
      .ilike("login_id", escapeLike(candidate))
      .limit(2);
    if (error) throw new Error(error.message);
    if (data && data.length === 1) return data[0] as EmployeeLoginRow;
    if (data && data.length > 1) return null; // 대소문자만 다른 아이디가 둘 이상이면 어느 쪽인지 정하지 않는다
  }
  return null;
}

function isLocked(employee: EmployeeLoginRow, now: Date) {
  const count = employee.failed_login_count ?? 0;
  const last = employee.last_failed_login_at ? new Date(employee.last_failed_login_at).getTime() : 0;
  return count >= MAX_FAILED_ATTEMPTS && now.getTime() - last < LOCK_MS;
}

function failure() {
  return NextResponse.json({ error: GENERIC_FAILURE }, { status: 401 });
}

async function recordFailure(employee: EmployeeLoginRow) {
  const { data } = await createAdminClient().rpc("record_login_failure", { p_employee_id: employee.id });
  logError("LOGIN_FAILED", `로그인 실패: ${employee.login_id ?? ""}`, {
    resource: "employee",
    resource_id: employee.id,
    details: { failed_count: typeof data === "number" ? data : null },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    const loginId = typeof body?.login_id === "string" ? body.login_id.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!loginId || !password || loginId.length > 200 || password.length > 200) {
      return NextResponse.json({ error: "로그인 ID와 비밀번호를 입력해 주세요." }, { status: 400 });
    }

    const now = new Date();
    const employee = await findEmployeeByLoginId(loginId);

    // 잠긴 계정은 비밀번호를 확인하지 않고 같은 실패 응답을 준다(잠긴 동안 맞혀 보는 것도 막는다).
    if (employee && isLocked(employee, now)) {
      await recordFailure(employee);
      return failure();
    }

    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email: toAuthEmail(employee?.login_id || loginId),
      password,
    });

    if (error || !data.user) {
      if (employee) await recordFailure(employee);
      return failure();
    }

    // 비밀번호는 맞지만 직원이 아니거나(회원가입 계정) 비활성이면 들이지 않는다. 응답은 같은 실패.
    const admin = createAdminClient();
    const { data: linked } = await admin
      .from("employees")
      .select("id, is_active")
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
        last_login_at: now.toISOString(),
      })
      .eq("id", linked.id);

    logInfo("LOGIN_SUCCESS", `로그인 성공: ${employee?.login_id ?? loginId}`, {
      resource: "employee",
      resource_id: linked.id as string,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[login]", error instanceof Error ? error.message : error);
    return failure();
  }
}
