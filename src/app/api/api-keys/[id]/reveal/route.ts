import { NextRequest, NextResponse } from "next/server";

import { decryptApiKey } from "@/lib/api-key-secret";
import { logInfo } from "@/lib/logger";
import { createRouteAuthErrorResponse, forbiddenResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/yb-api/refs";

/** 내 API 키 원문 다시 보기. 다른 직원의 키는 관리자라도 볼 수 없다. */
export async function GET(
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

    const { data, error } = await createAdminClient()
      .from("api_keys")
      .select("id, name, key_encrypted, employee_id, is_active")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[api-keys] reveal", error.message);
      return NextResponse.json({ error: "API 키를 불러오지 못했습니다." }, { status: 500 });
    }

    if (!data || data.is_active !== true) {
      return NextResponse.json({ error: "API Key를 찾을 수 없습니다." }, { status: 404 });
    }

    if (data.employee_id !== employee.id) {
      return forbiddenResponse("자기 API 키만 볼 수 있습니다.");
    }

    if (!data.key_encrypted) {
      return NextResponse.json(
        {
          error:
            "이 API Key는 기존 방식으로 생성되어 전체 값을 다시 확인할 수 없습니다. 새로 생성해주세요.",
        },
        { status: 409 }
      );
    }

    const rawKey = decryptApiKey(data.key_encrypted);

    logInfo("REVEAL_API_KEY", `API 키 조회: ${data.name}`, {
      resource: "api_key",
      resource_id: id,
      actor_id: user.id,
    });

    return NextResponse.json({ data: { raw_key: rawKey } }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
