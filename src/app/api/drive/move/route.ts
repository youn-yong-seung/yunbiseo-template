import { NextRequest, NextResponse } from "next/server";
import { moveFile, DriveAccessError, assertInsideAllowedRoots } from "@/lib/google-drive";
import { logInfo } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export async function POST(request: NextRequest) {
  try {
    const { user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const { fileIds, fromFolderId, toFolderId } = await request.json();
    if (!fileIds?.length || !fromFolderId || !toFolderId) {
      return NextResponse.json(
        { error: "fileIds, fromFolderId, toFolderId 필요" },
        { status: 400 }
      );
    }

    if (!Array.isArray(fileIds) || fileIds.length > 100) {
      return NextResponse.json({ error: "fileIds 는 100개 이하 배열이어야 합니다" }, { status: 400 });
    }
    // 옮길 파일은 최상위 폴더 자체가 아니어야 하고, 출발·도착 폴더는 모두 윤비서 폴더 안이어야 한다.
    await assertInsideAllowedRoots(fileIds, undefined, undefined, { allowRoot: false });
    await assertInsideAllowedRoots([fromFolderId, toFolderId]);
    const results = [];
    for (const fileId of fileIds) {
      const result = await moveFile(fileId, fromFolderId, toFolderId);
      results.push(result);
    }

    logInfo("MOVE_FILES", `파일 ${fileIds.length}개 이동`, {
      resource: "drive_file",
      details: { fileIds, fromFolderId, toFolderId },
    });

    return NextResponse.json({ success: true, moved: results.length });
  } catch (error) {
    if (error instanceof DriveAccessError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("Move files error:", error);
    return NextResponse.json(
      { error: "파일 이동 실패" },
      { status: 500 }
    );
  }
}
