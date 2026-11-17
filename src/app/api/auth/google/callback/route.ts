import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/gmail";
import { requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const OAUTH_STATE_COOKIE = "yb_google_oauth_state";

function redirectToMail(request: NextRequest, error: string) {
  const response = NextResponse.redirect(new URL(`/dashboard/my?google=${encodeURIComponent(error)}`, request.url));
  response.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/auth/google" });
  return response;
}

function sameState(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Google 계정 연결 마무리.
 * - state 가 시작할 때 심은 쿠키와 같아야 한다.
 * - 토큰은 로그인한 본인 것으로만 저장한다.
 * - 회사 공용(is_global, 다른 직원 일정도 이 계정 캘린더에 올림)은 관리자가 연결할 때만 켠다.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const state = searchParams.get("state");

  if (error || !code) {
    return redirectToMail(request, "no_code");
  }

  if (!sameState(state, request.cookies.get(OAUTH_STATE_COOKIE)?.value)) {
    return redirectToMail(request, "invalid_state");
  }

  try {
    const { user, employee, authUnavailable } = await requireRouteUser();
    if (!user || !employee) {
      return redirectToMail(
        request,
        authUnavailable ? "auth_unavailable" : "unauthorized"
      );
    }

    const tokenData = await exchangeCode(code);

    // refresh_token이 없으면(재연결 시) 기존 값을 보존
    const upsertData: Record<string, unknown> = {
      user_id: user.id,
      gmail_email: tokenData.email,
      access_token: tokenData.access_token,
      token_expiry: new Date(tokenData.expiry_date).toISOString(),
      is_global: employee.isAdmin,
    };
    if (tokenData.refresh_token) {
      upsertData.refresh_token = tokenData.refresh_token;
    }

    const admin = createAdminClient();
    if (employee.isAdmin) {
      // 회사 공용 토큰은 하나만 둔다.
      await admin.from("google_oauth_tokens").update({ is_global: false }).neq("user_id", user.id);
    }
    const { error: upsertError } = await admin.from("google_oauth_tokens").upsert(
      upsertData,
      { onConflict: "user_id" }
    );

    if (upsertError) {
      console.error("Token save error:", upsertError.message);
      return redirectToMail(request, "token_save_failed");
    }

    return redirectToMail(request, "connected");
  } catch (err) {
    console.error("OAuth callback error:", err instanceof Error ? err.message : err);
    return redirectToMail(request, "oauth_failed");
  }
}
