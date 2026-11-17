import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, errorResponse, normalizeText, parseLimit, resolveActor, unauthorized, dbError } from "@/lib/yb-api/refs";
import { PROJECT_SELECT, parseProjectStatus, pickProjectFields, selectProject, setProjectStatus, syncProjectAssignees } from "./_shared";

/**
 * 프로젝트 외부 API (yb project). API 키 필수.
 *
 * GET  /api/projects?q=이름|26-3&status=진행중&limit=20
 * POST /api/projects  { name, type?: "교육", customer_id?, status?, start_date?, end_date?, manager?, description? }
 *      번호(YY-N)는 자동으로 매긴다.
 */
export async function GET(request: NextRequest) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const params = request.nextUrl.searchParams;
    const supabase = createAdminClient();

    let query = supabase.from("projects").select(PROJECT_SELECT);
    const q = params.get("q")?.trim();
    if (q) {
      const like = `%${q.replace(/[,()]/g, " ")}%`;
      query = query.or(`name.ilike.${like},project_number.ilike.${like},client.ilike.${like}`);
    }
    const statuses = (params.get("status") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    if (statuses.length === 1) query = query.eq("status", statuses[0]);
    if (statuses.length > 1) query = query.in("status", statuses);

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(parseLimit(params.get("limit"), 20, 200));
    if (error) throw dbError(error);
    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = await validateApiKeyRecord(request);
    if (!apiKey) return unauthorized();
    const body = await request.json();
    if (!normalizeText(body.name)) throw new BadRequest("name is required");

    const supabase = createAdminClient();
    const fields = await pickProjectFields(supabase, body);
    const status = body.status !== undefined ? parseProjectStatus(body.status) : "진행예정";

    const { data: projectNumber, error: numberError } = await supabase.rpc("generate_project_number");
    if (numberError || !projectNumber) throw new Error(numberError?.message ?? "프로젝트 번호를 만들지 못했습니다");

    // 처음 단계도 바꾼 사람과 함께 남기려고 '진행예정'으로 만든 뒤 필요하면 단계를 바꾼다.
    const { data: inserted, error } = await supabase
      .from("projects")
      .insert({ ...fields, project_number: projectNumber, status: "진행예정" })
      .select("id")
      .single();
    if (error || !inserted) throw new BadRequest(error?.message ?? "Project insert failed");

    if (fields.manager !== undefined) {
      await syncProjectAssignees(supabase, inserted.id, fields.manager as string | null);
    }
    if (status !== "진행예정") {
      const actor = await resolveActor(apiKey);
      await setProjectStatus(supabase, inserted.id, status, null, actor?.id ?? null);
    }

    const data = await selectProject(supabase, inserted.id);
    logInfo("CREATE_PROJECT_API", `외부 API 프로젝트 등록: ${projectNumber} ${fields.name}`, {
      resource: "project",
      resource_id: inserted.id,
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
