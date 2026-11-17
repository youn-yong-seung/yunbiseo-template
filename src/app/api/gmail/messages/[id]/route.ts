import { NextRequest, NextResponse } from "next/server";
import { GmailAuthError, getMessage, markAsRead } from "@/lib/gmail";
import { deleteGmailToken, getGmailToken } from "@/lib/gmail-token";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, authUnavailable } = await requireRouteUser();
  if (!user) return createRouteAuthErrorResponse(authUnavailable);

  const token = await getGmailToken(null, user.id);
  if (!token) return NextResponse.json({ error: "not_connected" }, { status: 401 });

  const tokenOptions = { onTokenRefreshed: token.onTokenRefreshed };

  try {
    const message = await getMessage(
      token.accessToken,
      token.refreshToken,
      token.expiryDate,
      id,
      tokenOptions
    );

    if (!message.isRead) {
      await markAsRead(
        token.accessToken,
        token.refreshToken,
        token.expiryDate,
        id,
        tokenOptions
      ).catch(() => null);
    }

    return NextResponse.json(message);
  } catch (err) {
    console.error("Gmail get message error:", err);
    if (err instanceof GmailAuthError) {
      await deleteGmailToken(null, token.tokenId, user.id);
      return NextResponse.json({ error: "token_expired", message: "Google 계정을 다시 연결해 주세요." }, { status: 401 });
    }
    return NextResponse.json({ error: "gmail_error" }, { status: 500 });
  }
}
