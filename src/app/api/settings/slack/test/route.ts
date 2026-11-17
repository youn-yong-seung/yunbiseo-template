import { requireRouteAdmin } from "@/lib/route-auth";
import { publicErrorMessage } from "@/lib/safe-error";
import { sendSlackProjectTestMessage } from "@/lib/slack";

export async function POST() {
  // 외부 서비스 키 설정은 관리자만 보고 바꾼다.
  const auth = await requireRouteAdmin();
  if (!auth.ok) return auth.response;

  try {
    await sendSlackProjectTestMessage();
    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Slack 테스트 발송에 실패했습니다.") },
      { status: 500 }
    );
  }
}
