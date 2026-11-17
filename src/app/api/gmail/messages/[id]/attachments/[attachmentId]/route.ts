import { NextRequest, NextResponse } from "next/server";
import { GmailAuthError, getGmailClient } from "@/lib/gmail";
import { deleteGmailToken, getGmailToken } from "@/lib/gmail-token";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  const { id: messageId, attachmentId } = await params;
  const { user, authUnavailable } = await requireRouteUser();
  if (!user) return createRouteAuthErrorResponse(authUnavailable);

  const token = await getGmailToken(null, user.id);
  if (!token) return NextResponse.json({ error: "not_connected" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const filename = (searchParams.get("filename") ?? "attachment").slice(0, 200);
  // 주소에 실려 온 형식 값은 믿지 않는다. 안전한 형식 문자열만 쓰고, 항상 내려받기로 보낸다.
  const mimeParam = searchParams.get("mimeType") ?? "";
  const mimeType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeParam) && !/html|xml|javascript|svg/i.test(mimeParam)
    ? mimeParam
    : "application/octet-stream";

  try {
    const gmail = await getGmailClient(
      token.accessToken,
      token.refreshToken,
      token.expiryDate,
      { onTokenRefreshed: token.onTokenRefreshed }
    );

    const res = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });

    const base64Data = res.data.data;
    if (!base64Data) {
      return NextResponse.json({ error: "첨부파일 데이터가 없습니다." }, { status: 404 });
    }

    const buffer = Buffer.from(base64Data.replace(/-/g, "+").replace(/_/g, "/"), "base64");

    const encodedFilename = encodeURIComponent(filename);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodedFilename}`,
        "Content-Length": buffer.length.toString(),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("Attachment fetch error:", err);
    if (err instanceof GmailAuthError) {
      await deleteGmailToken(null, token.tokenId, user.id);
      return NextResponse.json({ error: "token_expired", message: "Google 계정을 다시 연결해 주세요." }, { status: 401 });
    }
    return NextResponse.json({ error: "첨부파일을 불러오지 못했습니다." }, { status: 500 });
  }
}
