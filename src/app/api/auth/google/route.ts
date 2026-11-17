import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/gmail";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export const OAUTH_STATE_COOKIE = "yb_google_oauth_state";

/**
 * Google 계정 연결 시작. 매번 새 state 를 만들어 httpOnly 쿠키에 두고, 콜백에서 같은지 확인한다
 * (남이 만든 연결 요청을 내 브라우저에서 끝내게 하는 공격을 막는다).
 */
export async function GET() {
  const { user, authUnavailable } = await requireRouteUser();
  if (!user) {
    return createRouteAuthErrorResponse(authUnavailable);
  }

  const state = randomBytes(24).toString("hex");
  const response = NextResponse.redirect(getAuthUrl(state));
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/google",
    maxAge: 600,
  });
  return response;
}
