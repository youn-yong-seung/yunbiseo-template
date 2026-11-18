import { NextRequest, NextResponse } from "next/server";
import { GmailAuthError, sendEmail } from "@/lib/gmail";
import { deleteGmailToken, getGmailToken } from "@/lib/gmail-token";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

function hasHeaderBreak(value: string) {
  return /[\r\n\0]/.test(value);
}

export async function POST(request: NextRequest) {
  const { user, authUnavailable } = await requireRouteUser();
  if (!user) return createRouteAuthErrorResponse(authUnavailable);

  const body = (await request.json().catch(() => null)) ?? {};
  const { to, subject, message, replyToMessageId, threadId } = body;

  if (!to || !subject || !message) {
    return NextResponse.json({ error: "to, subject, message는 필수입니다." }, { status: 400 });
  }
  if (typeof to !== "string" || typeof subject !== "string" || typeof message !== "string") {
    return NextResponse.json({ error: "to, subject, message는 문자열이어야 합니다." }, { status: 400 });
  }
  // 메일 머리글에 들어가는 값에 줄바꿈이 있으면 받는 사람·머리글을 몰래 덧붙일 수 있다(헤더 주입). 거부한다.
  const headerValues: Array<[string, unknown]> = [
    ["to", to],
    ["subject", subject],
    ["replyToMessageId", replyToMessageId],
    ["threadId", threadId],
  ];
  for (const [field, value] of headerValues) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || hasHeaderBreak(value) || value.length > 2000) {
      return NextResponse.json({ error: `${field} 값이 올바르지 않습니다(줄바꿈 불가).` }, { status: 400 });
    }
  }

  const token = await getGmailToken(null, user.id);
  if (!token) return NextResponse.json({ error: "not_connected" }, { status: 401 });

  try {
    await sendEmail(
      token.accessToken,
      token.refreshToken,
      token.expiryDate,
      { to, subject, body: message, replyToMessageId, threadId },
      { onTokenRefreshed: token.onTokenRefreshed }
    );
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Gmail send error:", err);
    if (err instanceof GmailAuthError) {
      await deleteGmailToken(null, token.tokenId, user.id);
      return NextResponse.json({ error: "token_expired", message: "Google 계정을 다시 연결해 주세요." }, { status: 401 });
    }
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }
}
