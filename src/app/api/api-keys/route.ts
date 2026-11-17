import { NextRequest, NextResponse } from "next/server";
import { issueApiKey } from "@/lib/api-key-issue";
import { logInfo } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * API 키 목록·발급 (로그인 세션 전용).
 * - 일반 직원: 자기 키만 본다.
 * - 관리자: 모든 직원의 키를 본다(폐기용). 키 값 보기는 자기 키만 된다(/reveal).
 * - 새 키는 항상 로그인한 본인 키로 만든다. 다른 직원 명의로 만들 수 없다.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, employee, authUnavailable } = await requireRouteUser();
    if (!user || !employee) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const scope = request.nextUrl.searchParams.get("scope");
    const admin = createAdminClient();
    let query = admin
      .from("api_keys")
      .select("id, name, key_prefix, created_by, employee_id, last_used_at, is_active, created_at, updated_at, key_encrypted")
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    // 관리자도 마이페이지(scope=mine)에서는 자기 키만 본다.
    if (!employee.isAdmin || scope === "mine") query = query.eq("employee_id", employee.id);

    const { data, error } = await query;

    if (error) {
      console.error("[api-keys] list", error.message);
      return NextResponse.json({ error: "API 키 목록을 불러오지 못했습니다." }, { status: 500 });
    }

    const result = (data ?? []).map(({ key_encrypted, ...apiKey }) => ({
      ...apiKey,
      is_mine: apiKey.employee_id === employee.id,
      can_reveal: Boolean(key_encrypted) && apiKey.employee_id === employee.id,
    }));

    return NextResponse.json({ data: result });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, employee, authUnavailable } = await requireRouteUser();
    if (!user || !employee) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const body = await request.json().catch(() => null);
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 100) : "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    let issued;
    try {
      issued = await issueApiKey(createAdminClient(), {
        name,
        employeeId: employee.id,
        employeeName: employee.name,
      });
    } catch {
      return NextResponse.json({ error: "API 키 생성에 실패했습니다." }, { status: 500 });
    }
    const { raw_key: rawKey, ...data } = issued;

    logInfo("CREATE_API_KEY", `API 키 생성: ${name}`, { resource: "api_key", resource_id: data.id, actor_id: user.id });
    // 원본 Key는 이 응답에서만 1회 제공
    return NextResponse.json({ data: { ...data, is_mine: true, raw_key: rawKey } }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
