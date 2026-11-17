import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

export async function requireRouteUser() {
  const supabase = await createClient();
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error) {
      return {
        supabase,
        user: null,
        authUnavailable: isTransientAuthError(error),
      };
    }

    if (!user) {
      return { supabase, user: null, authUnavailable: false };
    }

    return { supabase, user, authUnavailable: false };
  } catch {
    return { supabase, user: null, authUnavailable: true };
  }
}

export function createRouteAuthErrorResponse(authUnavailable = false) {
  if (authUnavailable) {
    return NextResponse.json(
      { error: "Auth service unavailable" },
      { status: 503 }
    );
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function isTransientAuthError(error: { message?: string; status?: number }) {
  const msg = error.message?.toLowerCase() ?? "";

  if (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("timeout")
  ) {
    return true;
  }

  return Boolean(error.status && error.status >= 500);
}

/**
 * 웹 화면(로그인 세션)과 yb CLI(x-api-key) 둘 다 받는 API 용.
 * 통과하면 기록에 남길 actorId(로그인 사용자 id, API 키면 null)를 돌려준다.
 */
export async function requireRouteUserOrApiKey(request: Request) {
  if (request.headers.get("x-api-key") || request.headers.get("authorization")) {
    const { validateApiKeyRecord } = await import("@/lib/api-key");
    const record = await validateApiKeyRecord(request as import("next/server").NextRequest);
    if (record) return { ok: true as const, actorId: null as string | null, apiKeyName: record.created_by ?? record.name };
    return { ok: false as const, response: createRouteAuthErrorResponse(false) };
  }
  const { user, authUnavailable } = await requireRouteUser();
  if (!user) return { ok: false as const, response: createRouteAuthErrorResponse(authUnavailable) };
  return { ok: true as const, actorId: user.id as string | null, apiKeyName: null as string | null };
}
