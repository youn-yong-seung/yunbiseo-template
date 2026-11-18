import { NextRequest, NextResponse } from "next/server";
import { assertInsideAllowedRoots, DriveAccessError } from "@/lib/google-drive";
import { buildFileContent, saveMeetingFile } from "@/lib/meeting-drive";
import { logInfo } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 미팅 전사록/요약본을 연결된 프로젝트의 Drive 폴더에 파일로 저장합니다.
 * POST { meetingId }
 */
export async function POST(request: NextRequest) {
  try {
    const { user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const { meetingId } = await request.json();
    if (!meetingId) {
      return NextResponse.json({ error: "meetingId 필요" }, { status: 400 });
    }

    const supabase = await createClient();

    // 미팅 조회
    const { data: meeting, error: meetingError } = await supabase
      .from("meetings")
      .select("id, title, transcript, summary, started_at, ended_at, project_id, drive_file_id")
      .eq("id", meetingId)
      .single();

    if (meetingError || !meeting) {
      return NextResponse.json({ error: "미팅을 찾을 수 없습니다" }, { status: 404 });
    }

    // 프로젝트 연결 확인
    if (!meeting.project_id) {
      return NextResponse.json({ error: "연결된 프로젝트가 없습니다" }, { status: 400 });
    }

    // 전사록 또는 요약본이 있어야 함
    if (!meeting.transcript?.trim() && !meeting.summary?.trim()) {
      return NextResponse.json({ error: "전사록 또는 요약본이 없습니다" }, { status: 400 });
    }

    // 프로젝트의 Drive 폴더 ID 조회
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, drive_folder_id, project_number, name")
      .eq("id", meeting.project_id)
      .single();

    if (projectError || !project?.drive_folder_id) {
      return NextResponse.json({ error: "프로젝트 Drive 폴더가 없습니다" }, { status: 400 });
    }

    const content = buildFileContent(meeting);
    const buffer = Buffer.from(content, "utf-8");
    const fileName = `${meeting.title}.txt`;

    // 저장할 폴더가 윤비서 Drive 최상위 폴더 안인지 확인한다(밖이면 거부).
    try {
      await assertInsideAllowedRoots([project.drive_folder_id]);
    } catch (error) {
      if (error instanceof DriveAccessError) {
        return NextResponse.json({ error: "프로젝트 Drive 폴더가 윤비서 Drive 폴더 밖에 있어 저장하지 않았습니다." }, { status: 403 });
      }
      throw error;
    }

    const fileId = await saveMeetingFile(meeting.drive_file_id, project.drive_folder_id, fileName, buffer);

    // drive_file_id 는 서버만 쓴다(직원 브라우저 쓰기는 DB 트리거가 막는다).
    if (fileId && fileId !== meeting.drive_file_id) {
      await createAdminClient()
        .from("meetings")
        .update({ drive_file_id: fileId })
        .eq("id", meetingId);
    }

    logInfo("SYNC_MEETING_DRIVE", `미팅 회의록 Drive 저장: ${meeting.title}`, {
      resource: "meeting",
      resource_id: meetingId,
    });

    return NextResponse.json({ success: true, fileId });
  } catch (error) {
    console.error("Meeting drive sync error:", error);
    return NextResponse.json({ error: "Drive 파일 저장 실패" }, { status: 500 });
  }
}
