import { NextRequest, NextResponse } from "next/server";

import { logInfo } from "@/lib/logger";
import { forbiddenResponse, requireRouteUserOrApiKey } from "@/lib/route-auth";
import { canEditSchedule } from "@/lib/schedule-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, NotFound, UUID_RE, dbError, errorResponse, normalizeText, parseLimit } from "@/lib/yb-api/refs";
import {
  SCHEDULE_SELECT,
  assertValidRange,
  buildScheduleTimes,
  normalizeCategory,
  parseBoolean,
  replaceAttendees,
  resolveAttendeeIds,
  selectSchedule,
  syncCreateToGoogle,
  syncDeleteToGoogle,
} from "./_shared";

/**
 * 일정 API (yb schedule·today 가 사용). 로그인 세션 또는 API 키.
 *
 * GET    /api/schedules?from=ISO|YYYY-MM-DD&to=...&q=&category=&assignee=me|이름&limit=50   (id=<uuid> 로 한 건)
 * POST   /api/schedules  { title, date?, time?, duration_min?, start_at?, end_at?, all_day?, category?, location?,
 *                          description?, assignees?, attendee_ids?, project_id?, customer_id?, add_google_meet? }
 * DELETE /api/schedules?id=<uuid>
 *
 * 일정은 회사 직원이 모두 볼 수 있다. 고치고 지우는 것은 만든 사람·참석자·관리자만 한다.
 */
function toRangeIso(value: string | null, endOfDay: boolean) {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return new Date(`${text}T${endOfDay ? "23:59:59" : "00:00:00"}+09:00`).toISOString();
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new BadRequest("from/to 는 YYYY-MM-DD 또는 ISO 날짜시간이어야 합니다");
  return date.toISOString();
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireRouteUserOrApiKey(request);
    if (!auth.ok) return auth.response;
    const me = auth.actor.employee;

    const params = request.nextUrl.searchParams;
    const supabase = createAdminClient();

    const id = params.get("id")?.trim();
    if (id) {
      if (!UUID_RE.test(id)) throw new NotFound("일정을 찾지 못했습니다");
      const data = await selectSchedule(supabase, id);
      if (!data) throw new NotFound("일정을 찾지 못했습니다");
      return NextResponse.json({ data: [data] });
    }

    let query = supabase.from("schedules").select(SCHEDULE_SELECT);
    const from = toRangeIso(params.get("from"), false);
    const to = toRangeIso(params.get("to"), true);
    if (from) query = query.gte("start_at", from);
    if (to) query = query.lte("start_at", to);
    const q = params.get("q")?.trim();
    if (q) query = query.ilike("title", `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    const category = params.get("category")?.trim();
    if (category) query = query.eq("category", category);

    const { data, error } = await query
      .order("start_at", { ascending: true })
      .limit(parseLimit(params.get("limit"), 50, 200));
    if (error) throw dbError(error);

    let rows = (data ?? []) as unknown as Array<{
      created_by: string | null;
      attendees: { employee_id: string; employees: { name: string } | null }[];
    }>;

    // assignee=me|이름: 그 직원이 참석자이거나 만든 일정만
    const assignee = params.get("assignee")?.trim() || (parseBoolean(params.get("mine")) ? "me" : "");
    if (assignee) {
      let targetId: string | null = null;
      if (assignee === "me" || assignee === "나") targetId = me.id;
      else if (UUID_RE.test(assignee)) targetId = assignee;
      else {
        const { data: emp } = await supabase
          .from("employees")
          .select("id")
          .ilike("name", assignee.replace(/[\\%_]/g, (ch) => `\\${ch}`))
          .limit(1)
          .maybeSingle();
        if (!emp) throw new BadRequest(`직원을 찾지 못했습니다: ${assignee}`);
        targetId = emp.id as string;
      }
      rows = rows.filter(
        (row) => row.created_by === targetId || row.attendees.some((a) => a.employee_id === targetId),
      );
    }

    return NextResponse.json({ data: rows });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireRouteUserOrApiKey(request);
    if (!auth.ok) return auth.response;
    const actor = auth.actor;
    const me = actor.employee;

    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const title = normalizeText(body.title);
    if (!title) throw new BadRequest("title(일정 제목)이 필요합니다");
    if (title.length > 200) throw new BadRequest("title 은 200자 이하여야 합니다");

    const supabase = createAdminClient();
    const times = buildScheduleTimes(body);
    assertValidRange(times.start_at, times.end_at);
    const category = await normalizeCategory(supabase, body.category);
    // 담당자를 안 주면 만든 사람(나)이 담당자다 — "내 일정"으로 보이게.
    const attendeeIds = (await resolveAttendeeIds(supabase, body, me)) ?? [me.id];

    // 만든 사람은 부른 직원이다. 관리자만 created_by 로 다른 직원 명의를 줄 수 있다.
    let createdBy = me.id;
    const requestedCreator = normalizeText(body.created_by);
    if (requestedCreator && requestedCreator !== me.id) {
      if (!me.isAdmin) throw new BadRequest("created_by 는 관리자만 바꿀 수 있습니다");
      if (!UUID_RE.test(requestedCreator)) throw new BadRequest("created_by 는 직원 id 여야 합니다");
      createdBy = requestedCreator;
    }

    const base = {
      title,
      description: normalizeText(body.description),
      start_at: times.start_at,
      end_at: times.end_at,
      all_day: times.all_day,
      category,
      location: normalizeText(body.location),
      project_id: normalizeText(body.project_id),
      customer_id: normalizeText(body.customer_id),
      lead_id: normalizeText(body.lead_id),
      created_by: createdBy,
      recurrence_type: "none",
      sync_source: "local",
    };

    // 웹 화면과 같은 규칙: 미팅 유형이면 구글 미트 링크를 같이 만든다(구글 연동이 있을 때만).
    const addMeet = parseBoolean(body.add_google_meet ?? body.addGoogleMeet, false) || category === "meeting";
    const { meta, warning } = await syncCreateToGoogle(supabase, actor, base, attendeeIds, addMeet);
    const row = { ...base, ...meta } as Record<string, unknown>;
    if (addMeet && typeof meta.google_meet_link === "string" && !base.location) row.location = meta.google_meet_link;

    const { data: inserted, error } = await supabase.from("schedules").insert(row).select("id").single();
    if (error || !inserted) throw dbError(error);
    await replaceAttendees(supabase, inserted.id as string, attendeeIds);

    const data = await selectSchedule(supabase, inserted.id as string);
    logInfo("CREATE_SCHEDULE_API", `일정 등록: ${title}`, { resource: "schedule", resource_id: inserted.id as string });
    return NextResponse.json({ data, created: true, warning }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireRouteUserOrApiKey(request);
    if (!auth.ok) return auth.response;

    const id = request.nextUrl.searchParams.get("id")?.trim() ?? "";
    if (!UUID_RE.test(id)) throw new BadRequest("id(일정 uuid)가 필요합니다");

    const supabase = createAdminClient();
    const existing = await selectSchedule(supabase, id);
    if (!existing) throw new NotFound("일정을 찾지 못했습니다");
    if (!(await canEditSchedule(id, auth.actor.employee))) {
      return forbiddenResponse("이 일정은 만든 사람·참석자·관리자만 지울 수 있습니다.");
    }

    const warning = await syncDeleteToGoogle(supabase, auth.actor, existing as unknown as {
      google_event_id: string | null;
      google_calendar_id: string | null;
    });
    const { error } = await supabase.from("schedules").delete().eq("id", id);
    if (error) throw dbError(error);

    logInfo("DELETE_SCHEDULE_API", `일정 삭제: ${(existing as unknown as { title: string }).title}`, {
      resource: "schedule",
      resource_id: id,
    });
    return NextResponse.json({ deleted: true, data: existing, warning });
  } catch (error) {
    return errorResponse(error);
  }
}
