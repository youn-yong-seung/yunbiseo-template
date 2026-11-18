import { NextResponse } from "next/server";
import { assertInsideAllowedRoots } from "@/lib/google-drive";
import { buildFileContent, saveMeetingFile } from "@/lib/meeting-drive";
import { logInfo } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * 프로젝트에 연결된 모든 미팅의 전사록/요약본을 Drive 폴더에 일괄 저장합니다.
 */
export async function POST() {
  try {
    const { user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const supabase = await createClient();

    // 프로젝트가 연결되어 있고 전사록 또는 요약이 있는 미팅 조회
    const { data: meetings, error: meetingsError } = await supabase
      .from("meetings")
      .select("id, title, transcript, summary, started_at, ended_at, project_id, drive_file_id")
      .not("project_id", "is", null);

    if (meetingsError) {
      return NextResponse.json({ error: "미팅 조회 실패" }, { status: 500 });
    }

    // 관련 프로젝트의 drive_folder_id 일괄 조회
    const projectIds = [...new Set(meetings?.map((m) => m.project_id).filter(Boolean) as string[])];
    const { data: projects } = await supabase
      .from("projects")
      .select("id, drive_folder_id")
      .in("id", projectIds);

    const projectFolderMap = new Map<string, string>();
    for (const p of projects ?? []) {
      if (p.drive_folder_id) {
        projectFolderMap.set(p.id, p.drive_folder_id);
      }
    }

    const results = { synced: 0, skipped: 0, errors: [] as string[] };
    const admin = createAdminClient();
    const folderChecks = new Map<string, boolean>();
    const folderInside = async (folderId: string) => {
      if (!folderChecks.has(folderId)) {
        try {
          await assertInsideAllowedRoots([folderId]);
          folderChecks.set(folderId, true);
        } catch {
          folderChecks.set(folderId, false);
        }
      }
      return folderChecks.get(folderId) === true;
    };

    for (const meeting of meetings ?? []) {
      try {
        // 전사록/요약이 없으면 스킵
        if (!meeting.transcript?.trim() && !meeting.summary?.trim()) {
          results.skipped++;
          continue;
        }

        const folderId = projectFolderMap.get(meeting.project_id!);
        if (!folderId) {
          results.skipped++;
          continue;
        }

        // 폴더가 윤비서 Drive 최상위 폴더 밖이면 건너뛴다.
        if (!(await folderInside(folderId))) {
          results.skipped++;
          results.errors.push(`${meeting.title}: 프로젝트 Drive 폴더가 윤비서 Drive 폴더 밖에 있어 건너뛰었습니다.`);
          continue;
        }

        const content = buildFileContent(meeting);
        const buffer = Buffer.from(content, "utf-8");
        const fileName = `${meeting.title}.txt`;

        const fileId = await saveMeetingFile(meeting.drive_file_id, folderId, fileName, buffer);

        if (fileId && fileId !== meeting.drive_file_id) {
          await admin
            .from("meetings")
            .update({ drive_file_id: fileId })
            .eq("id", meeting.id);
        }

        results.synced++;
      } catch (err) {
        // 외부(Drive)·DB 오류 원문은 서버 로그에만 남긴다.
        console.error("[drive-sync-all]", meeting.id, err instanceof Error ? err.message : err);
        results.errors.push(`${meeting.title}: 저장하지 못했습니다.`);
      }
    }

    logInfo("SYNC_ALL_MEETINGS_DRIVE", `미팅 회의록 일괄 Drive 저장`, {
      resource: "meeting",
      details: results,
    });

    return NextResponse.json(results);
  } catch (error) {
    console.error("Meeting drive sync all error:", error);
    return NextResponse.json({ error: "일괄 동기화 실패" }, { status: 500 });
  }
}
