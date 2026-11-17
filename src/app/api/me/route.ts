import { NextRequest, NextResponse } from "next/server";

import { requireRouteUserOrApiKey } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET /api/me — 지금 요청한 사람이 누구인지(yb whoami).
 * API 키로 부르면 키를 만든 직원, 로그인 세션이면 로그인한 직원을 돌려준다.
 * 키 원문·토큰은 돌려주지 않는다.
 */
export async function GET(request: NextRequest) {
  const auth = await requireRouteUserOrApiKey(request);
  if (!auth.ok) return auth.response;
  const { actor } = auth;

  const { data } = await createAdminClient()
    .from("employees")
    .select("id, name, department, position, employee_type, is_finance")
    .eq("id", actor.employee.id)
    .maybeSingle();

  let apiKey: { id: string; name: string; key_prefix: string } | null = null;
  if (actor.apiKeyId) {
    const { data: key } = await createAdminClient()
      .from("api_keys")
      .select("id, name, key_prefix")
      .eq("id", actor.apiKeyId)
      .maybeSingle();
    apiKey = (key as typeof apiKey) ?? null;
  }

  return NextResponse.json({
    employee: {
      id: actor.employee.id,
      name: actor.employee.name,
      department: data?.department ?? null,
      position: data?.position ?? null,
      employee_type: data?.employee_type ?? actor.employee.employee_type,
      is_admin: actor.employee.isAdmin,
      is_finance: actor.employee.is_finance,
    },
    via: actor.via,
    api_key: apiKey,
  });
}
