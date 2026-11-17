import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { logInfo, logError } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export async function PATCH(request: NextRequest) {
  try {
    const { user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const body = (await request.json().catch(() => null)) ?? {};
    const text = (value: unknown, max: number) =>
      typeof value === "string" ? value.trim().slice(0, max + 1) : "";
    const name = text(body.name, 50);
    const login_id = text(body.login_id, 100);
    const department = text(body.department, 100);
    const position = text(body.position, 100);
    const email = text(body.email, 200);
    const phone = text(body.phone, 50);

    // 이름은 API 키·기록·담당자 표시에 쓰인다. 길이·글자 종류를 제한하고 다른 직원과 겹치지 않게 한다.
    if (!name || name.length > 50 || /[\u0000-\u001f<>]/.test(name)) {
      return NextResponse.json({ error: "이름은 1~50자로, 특수 기호(<, >) 없이 입력해 주세요." }, { status: 400 });
    }
    if (!/^[A-Za-z0-9._@-]{2,100}$/.test(login_id)) {
      return NextResponse.json({ error: "아이디는 영문·숫자·. _ - @ 로 2~100자여야 합니다." }, { status: 400 });
    }
    if (department.length > 100 || position.length > 100 || email.length > 200 || phone.length > 50) {
      return NextResponse.json({ error: "입력값이 너무 깁니다." }, { status: 400 });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
    }

    const adminSupabase = createAdminClient();

    // 현재 직원 조회
    const { data: currentEmp } = await adminSupabase
      .from("employees")
      .select("id, login_id")
      .eq("auth_uid", user.id)
      .maybeSingle();

    if (!currentEmp) {
      return NextResponse.json(
        { error: "직원 정보를 찾을 수 없습니다" },
        { status: 404 }
      );
    }

    // 이름 중복 체크 (본인 제외, 대소문자·앞뒤 공백 무시)
    const { data: sameName } = await adminSupabase
      .from("employees")
      .select("id")
      .ilike("name", name.replace(/[\\%_]/g, (ch) => `\\${ch}`))
      .neq("id", currentEmp.id)
      .limit(1);
    if (sameName && sameName.length > 0) {
      return NextResponse.json({ error: "같은 이름의 직원이 이미 있습니다. 구분할 수 있게 바꿔 주세요." }, { status: 409 });
    }

    // login_id 중복 체크 (본인 제외)
    if (login_id.toLowerCase() !== (currentEmp.login_id ?? "").toLowerCase()) {
      const { data: existing } = await adminSupabase
        .from("employees")
        .select("id")
        .ilike("login_id", login_id.replace(/[\\%_]/g, (ch) => `\\${ch}`))
        .neq("id", currentEmp.id)
        .maybeSingle();

      if (existing) {
        return NextResponse.json(
          { error: "이미 사용 중인 아이디입니다" },
          { status: 409 }
        );
      }
    }

    // 직원 정보 업데이트 (employee_type 제외)
    const { error } = await adminSupabase
      .from("employees")
      .update({
        name,
        department: department || null,
        position: position || null,
        email: email || null,
        phone: phone || null,
        login_id,
      })
      .eq("id", currentEmp.id);

    if (error) {
      logError("UPDATE_PROFILE", `프로필 수정 실패: ${error.message}`, {
        resource: "employee",
        resource_id: currentEmp.id,
      });
      return NextResponse.json({ error: publicErrorMessage(error) }, { status: 400 });
    }

    // login_id가 변경된 경우 auth email도 업데이트
    const newEmail = `${login_id.toLowerCase()}@${process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "example.com"}`;
    if (user.email !== newEmail) {
      await adminSupabase.auth.admin.updateUserById(user.id, {
        email: newEmail,
      });
    }

    logInfo("UPDATE_PROFILE", "프로필 수정 완료", {
      resource: "employee",
      resource_id: currentEmp.id,
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "서버 오류가 발생했습니다" },
      { status: 500 }
    );
  }
}
