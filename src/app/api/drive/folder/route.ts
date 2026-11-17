import { NextRequest, NextResponse } from "next/server";
import { createFolder, DriveAccessError, assertInsideAllowedRoots } from "@/lib/google-drive";
import { logInfo } from "@/lib/logger";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

export async function POST(request: NextRequest) {
  try {
    const { user, authUnavailable } = await requireRouteUser();
    if (!user) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const { name, parentId: requestParentId } = await request.json();
    const parentId = requestParentId || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if (!parentId || typeof name !== "string" || !name.trim() || name.length > 200) {
      return NextResponse.json({ error: "폴더 이름과 Drive 설정을 확인해 주세요" }, { status: 400 });
    }
    await assertInsideAllowedRoots([parentId]);
    const folder = await createFolder(name, parentId);
    logInfo("CREATE_FOLDER", `폴더 생성: ${name}`, { resource: "drive_folder", resource_id: folder.id ?? undefined });
    return NextResponse.json(folder);
  } catch (error) {
    if (error instanceof DriveAccessError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error("Create folder error:", error);
    return NextResponse.json(
      { error: "폴더 생성에 실패했습니다" },
      { status: 500 }
    );
  }
}
