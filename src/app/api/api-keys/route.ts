import { NextRequest, NextResponse } from "next/server";
import { issueApiKey } from "@/lib/api-key-issue";
import { logInfo } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export async function GET() {
  try {
    const { supabase, user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const { data, error } = await supabase
      .from("api_keys")
      .select("id, name, key_prefix, created_by, last_used_at, is_active, created_at, updated_at, key_encrypted")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const result = (data ?? []).map(({ key_encrypted, ...apiKey }) => ({
      ...apiKey,
      can_reveal: Boolean(key_encrypted),
    }));

    return NextResponse.json({ data: result });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase, user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    // 현재 사용자의 직원 이름 조회
    const { data: employee } = await supabase
      .from("employees")
      .select("name")
      .eq("auth_uid", user.id)
      .maybeSingle();

    const createdBy = employee?.name ?? user.email ?? "Unknown";

    let issued;
    try {
      issued = await issueApiKey(supabase, { name, createdBy });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "API 키 생성에 실패했습니다." },
        { status: 500 }
      );
    }
    const { raw_key: rawKey, ...data } = issued;

    logInfo("CREATE_API_KEY", `API 키 생성: ${name}`, { resource: "api_key", resource_id: data.id, actor_id: user.id });
    // 원본 Key는 이 응답에서만 1회 제공
    return NextResponse.json({ data: { ...data, raw_key: rawKey } }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
