import { NextRequest, NextResponse } from "next/server";
import { logInfo } from "@/lib/logger";
import { createRouteAuthErrorResponse, forbiddenResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/yb-api/refs";

/** API 키 폐기. 자기 키는 본인이, 다른 직원 키는 관리자만 지울 수 있다. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, employee, authUnavailable } = await requireRouteUser();
    if (!user || !employee) {
      return createRouteAuthErrorResponse(authUnavailable);
    }
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: "API Key를 찾을 수 없습니다." }, { status: 404 });
    }

    const admin = createAdminClient();
    const { data: key } = await admin
      .from("api_keys")
      .select("id, name, employee_id")
      .eq("id", id)
      .maybeSingle();
    if (!key) {
      return NextResponse.json({ error: "API Key를 찾을 수 없습니다." }, { status: 404 });
    }
    if (key.employee_id !== employee.id && !employee.isAdmin) {
      return forbiddenResponse("다른 직원의 API 키는 관리자만 지울 수 있습니다.");
    }

    const { error } = await admin.from("api_keys").delete().eq("id", id);

    if (error) {
      console.error("[api-keys] delete", error.message);
      return NextResponse.json({ error: "API 키를 지우지 못했습니다." }, { status: 500 });
    }

    logInfo("DELETE_API_KEY", `API 키 삭제: ${key.name}`, { resource: "api_key", resource_id: id, actor_id: user.id });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
