import { runMeetingAiMatch } from "@/lib/meeting-ai-match";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export async function POST(request: Request) {
  const { supabase, user, authUnavailable } = await requireRouteUser();
  if (!user) {
    return createRouteAuthErrorResponse(authUnavailable);
  }

  const { meetingId } = await request.json();
  if (!meetingId || typeof meetingId !== "string") {
    return Response.json({ error: "meetingId is required" }, { status: 400 });
  }

  try {
    const result = await runMeetingAiMatch(supabase, meetingId);
    return Response.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Meeting AI match error:", msg, error);
    // 외부 AI·DB 오류 원문은 서버 로그에만 남긴다.
    return Response.json({ error: "AI 매칭에 실패했습니다. 잠시 뒤 다시 시도하세요." }, { status: 500 });
  }
}
