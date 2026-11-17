import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotFound, errorResponse, resolveProjectRef, unauthorized, dbError } from "@/lib/yb-api/refs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 프로젝트 단계 이력: GET /api/projects/<번호 또는 uuid>/status-history. API 키 필수.
 * previous_status 는 지금 단계로 오기 직전 단계다(yb project undo 가 쓴다).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id: ref } = await context.params;
    const supabase = createAdminClient();
    const id = await resolveProjectRef(supabase, ref);
    if (!id) throw new NotFound("Project not found");

    const { data: project } = await supabase
      .from("projects")
      .select("id, project_number, name, status")
      .eq("id", id)
      .maybeSingle();
    if (!project) throw new NotFound("Project not found");

    const { data: history, error } = await supabase
      .from("project_status_history")
      .select("id, from_status, to_status, changed_by_name, note, source, created_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw dbError(error);

    const latest = (history ?? []).find((row) => row.to_status === project.status);
    return NextResponse.json({
      success: true,
      data: { ...project, history: history ?? [], previous_status: latest?.from_status ?? null },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
