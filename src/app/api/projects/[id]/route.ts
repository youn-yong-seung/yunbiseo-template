import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BadRequest,
  NotFound,
  errorResponse,
  normalizeText,
  resolveActor,
  resolveProjectRef,
  unauthorized,
} from "@/lib/yb-api/refs";
import { parseProjectStatus, pickProjectFields, selectProject, setProjectStatus, syncProjectAssignees } from "../_shared";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 프로젝트 하나: GET·PATCH /api/projects/<번호(26-3) 또는 uuid>. API 키 필수.
 * PATCH 에 status 를 주면 단계가 바뀌고, status_note 가 이력의 사유로 남는다(yb project status 26-3 진행중 -m 이유).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id: ref } = await context.params;
    const supabase = createAdminClient();
    const id = await resolveProjectRef(supabase, ref);
    if (!id) throw new NotFound("Project not found");
    return NextResponse.json({ success: true, data: await selectProject(supabase, id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const apiKey = await validateApiKeyRecord(request);
    if (!apiKey) return unauthorized();
    const { id: ref } = await context.params;
    const body = await request.json();
    const supabase = createAdminClient();
    const id = await resolveProjectRef(supabase, ref);
    if (!id) throw new NotFound("Project not found");

    const fields = await pickProjectFields(supabase, body);
    const status = body.status !== undefined ? parseProjectStatus(body.status) : null;
    if (Object.keys(fields).length === 0 && !status) throw new BadRequest("바꿀 필드가 없습니다");

    if (Object.keys(fields).length > 0) {
      const { error } = await supabase.from("projects").update(fields).eq("id", id);
      if (error) throw new BadRequest(error.message);
    }
    if (fields.manager !== undefined) {
      await syncProjectAssignees(supabase, id, fields.manager as string | null);
    }
    if (status) {
      const actor = await resolveActor(supabase, apiKey.created_by);
      await setProjectStatus(supabase, id, status, normalizeText(body.status_note), actor?.id ?? null);
    }

    const data = await selectProject(supabase, id);
    logInfo("UPDATE_PROJECT_API", `외부 API 프로젝트 수정: ${data.project_number}`, {
      resource: "project",
      resource_id: id,
      details: { fields: Object.keys(fields), status },
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return errorResponse(error);
  }
}
