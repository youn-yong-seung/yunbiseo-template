import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
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

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 프로젝트 메모: GET·POST /api/projects/<번호 또는 uuid>/notes. API 키 필수.
 * POST { content } — 첫 줄이 메모 제목, 나머지가 본문이 된다(웹 화면의 프로젝트 메모 탭에 보인다).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id: ref } = await context.params;
    const supabase = createAdminClient();
    const id = await resolveProjectRef(supabase, ref);
    if (!id) throw new NotFound("Project not found");
    const { data, error } = await supabase
      .from("project_notes")
      .select("id, title, content, link_url, author_name, created_at, updated_at")
      .eq("project_id", id)
      .order("created_at", { ascending: false });
    if (error) throw new BadRequest(error.message);
    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const apiKey = await validateApiKeyRecord(request);
    if (!apiKey) return unauthorized();
    const { id: ref } = await context.params;
    const body = await request.json();
    const text = normalizeText(body.content);
    if (!text) throw new BadRequest("content is required");

    const supabase = createAdminClient();
    const id = await resolveProjectRef(supabase, ref);
    if (!id) throw new NotFound("Project not found");

    const [firstLine, ...rest] = text.split(/\r?\n/);
    const title = normalizeText(body.title) ?? firstLine.trim().slice(0, 100);
    const content = normalizeText(body.title) ? text : normalizeText(rest.join("\n"));
    const actor = await resolveActor(supabase, apiKey.created_by);

    const { data, error } = await supabase
      .from("project_notes")
      .insert({
        project_id: id,
        title,
        content,
        author_employee_id: actor?.id ?? null,
        author_name: actor?.name ?? apiKey.created_by ?? "API",
      })
      .select("id, title, content, author_name, created_at")
      .single();
    if (error) throw new BadRequest(error.message);
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
