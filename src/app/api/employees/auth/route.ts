import { randomInt } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { logInfo, logError } from "@/lib/logger";
import { requireRouteAdmin } from "@/lib/route-auth";

// 복잡한 비밀번호 자동 생성 (14자: 대문자+소문자+숫자+특수문자 포함, 암호학적 난수)
function generatePassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%^&*";
  const all = upper + lower + digits + special;
  const pick = (set: string) => set[randomInt(set.length)];

  const chars = [pick(upper), pick(lower), pick(digits), pick(special)];
  for (let i = 0; i < 10; i++) chars.push(pick(all));

  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join("");
}

const LOGIN_ID_RE = /^[A-Za-z0-9._@-]{2,100}$/;

// POST: 직원 Auth 유저 생성
export async function POST(request: NextRequest) {
  try {
    // 직원 계정 만들기·비밀번호 초기화·로그인 ID 변경은 관리자만 한다.
    const auth = await requireRouteAdmin();
    if (!auth.ok) return auth.response;

    const body = await request.json().catch(() => null);
    const employee_id = typeof body?.employee_id === "string" ? body.employee_id : "";
    const login_id = typeof body?.login_id === "string" ? body.login_id.trim() : "";
    if (!employee_id || !LOGIN_ID_RE.test(login_id)) {
      return NextResponse.json({ error: "직원과 로그인 ID(영문·숫자 2자 이상)를 확인해 주세요." }, { status: 400 });
    }
    const supabase = createAdminClient();

    const { data: target } = await supabase
      .from("employees")
      .select("id, auth_uid")
      .eq("id", employee_id)
      .maybeSingle();
    if (!target) {
      return NextResponse.json({ error: "직원을 찾을 수 없습니다." }, { status: 404 });
    }
    if (target.auth_uid) {
      return NextResponse.json({ error: "이미 로그인 계정이 있는 직원입니다. 비밀번호 초기화를 쓰세요." }, { status: 409 });
    }

    const password = generatePassword();

    // login_id에 @가 없으면 인증용 이메일 도메인을 붙인다
    const email = login_id.includes("@") ? login_id : `${login_id}@${process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com"}`;

    // Supabase Auth 유저 생성
    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

    if (authError) {
      logError("CREATE_AUTH", `직원 계정 생성 실패: ${authError.message}`, { resource: "employee", resource_id: employee_id });
      return NextResponse.json({ error: publicErrorMessage(authError) }, { status: 400 });
    }

    // employees 테이블에 auth_uid, login_id 업데이트
    const { error: updateError } = await supabase
      .from("employees")
      .update({
        auth_uid: authData.user.id,
        login_id,
        is_active: true,
        failed_login_count: 0,
        failed_login_window_started_at: null,
        last_failed_login_at: null,
      })
      .eq("id", employee_id);

    if (updateError) {
      return NextResponse.json(
        { error: publicErrorMessage(updateError) },
        { status: 400 }
      );
    }

    logInfo("CREATE_AUTH", `직원 계정 생성: ${login_id}`, { resource: "employee", resource_id: employee_id });
    return NextResponse.json({ success: true, auth_uid: authData.user.id, generated_password: password });
  } catch {
    return NextResponse.json(
      { error: "서버 오류가 발생했습니다" },
      { status: 500 }
    );
  }
}

// PUT: 비밀번호 재설정
export async function PUT(request: NextRequest) {
  try {
    // 직원 계정 만들기·비밀번호 초기화·로그인 ID 변경은 관리자만 한다.
    const auth = await requireRouteAdmin();
    if (!auth.ok) return auth.response;

    const body = await request.json().catch(() => null);
    const auth_uid = typeof body?.auth_uid === "string" ? body.auth_uid : "";
    const supabase = createAdminClient();

    // 직원에 연결된 계정만 초기화한다(임의의 auth 사용자 비밀번호를 바꾸지 못하게).
    const { data: target } = await supabase
      .from("employees")
      .select("id")
      .eq("auth_uid", auth_uid)
      .maybeSingle();
    if (!auth_uid || !target) {
      return NextResponse.json({ error: "직원 계정을 찾을 수 없습니다." }, { status: 404 });
    }

    const tempPassword = generatePassword();

    // Supabase Auth 비밀번호 업데이트
    const { error } = await supabase.auth.admin.updateUserById(auth_uid, {
      password: tempPassword,
    });

    if (error) {
      return NextResponse.json({ error: publicErrorMessage(error) }, { status: 400 });
    }

    logInfo("RESET_PASSWORD", "비밀번호 재설정", { resource: "employee", details: { auth_uid } });
    return NextResponse.json({ success: true, temp_password: tempPassword });
  } catch {
    return NextResponse.json(
      { error: "서버 오류가 발생했습니다" },
      { status: 500 }
    );
  }
}

// PATCH: 로그인 ID(이메일) 변경
export async function PATCH(request: NextRequest) {
  try {
    // 직원 계정 만들기·비밀번호 초기화·로그인 ID 변경은 관리자만 한다.
    const auth = await requireRouteAdmin();
    if (!auth.ok) return auth.response;

    const body = await request.json().catch(() => null);
    const auth_uid = typeof body?.auth_uid === "string" ? body.auth_uid : "";
    const login_id = typeof body?.login_id === "string" ? body.login_id.trim() : "";
    if (!auth_uid || !LOGIN_ID_RE.test(login_id)) {
      return NextResponse.json({ error: "로그인 ID(영문·숫자 2자 이상)를 확인해 주세요." }, { status: 400 });
    }
    const supabase = createAdminClient();
    const { data: target } = await supabase
      .from("employees")
      .select("id")
      .eq("auth_uid", auth_uid)
      .maybeSingle();
    if (!target) {
      return NextResponse.json({ error: "직원 계정을 찾을 수 없습니다." }, { status: 404 });
    }

    // login_id에 @가 없으면 인증용 이메일 도메인을 붙인다 (same logic as POST)
    const email = login_id.includes("@") ? login_id : `${login_id}@${process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com"}`;

    // Supabase Auth 이메일 업데이트
    const { error: authError } = await supabase.auth.admin.updateUserById(auth_uid, {
      email,
    });

    if (authError) {
      return NextResponse.json({ error: publicErrorMessage(authError) }, { status: 400 });
    }

    // employees 테이블의 login_id 업데이트
    const { error: updateError } = await supabase
      .from("employees")
      .update({ login_id })
      .eq("auth_uid", auth_uid);

    if (updateError) {
      return NextResponse.json({ error: publicErrorMessage(updateError) }, { status: 400 });
    }

    logInfo("CHANGE_LOGIN_ID", `로그인 ID 변경: ${login_id}`, { resource: "employee", details: { auth_uid } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "서버 오류가 발생했습니다" },
      { status: 500 }
    );
  }
}
