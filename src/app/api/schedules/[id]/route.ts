import { NextRequest, NextResponse } from "next/server";

import { logInfo } from "@/lib/logger";
import { forbiddenResponse, requireRouteUserOrApiKey } from "@/lib/route-auth";
import { canEditSchedule } from "@/lib/schedule-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, NotFound, UUID_RE, dbError, errorResponse, normalizeText } from "@/lib/yb-api/refs";
import {
  assertValidRange,
  buildScheduleTimes,
  normalizeCategory,
  replaceAttendees,
  resolveAttendeeIds,
  selectSchedule,
  syncDeleteToGoogle,
  syncUpdateToGoogle,
} from "../_shared";

type RouteContext = { params: Promise<{ id: string }> };

type ExistingSchedule = {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
  google_event_id: string | null;
  google_calendar_id: string | null;
  attendees: { employee_id: string }[];
};

async function loadExisting(id: string) {
  if (!UUID_RE.test(id)) throw new NotFound("일정을 찾지 못했습니다");
  const supabase = createAdminClient();
  const data = await selectSchedule(supabase, id);
  if (!data) throw new NotFound("일정을 찾지 못했습니다");
  return { supabase, existing: data as unknown as ExistingSchedule };
}

/** GET /api/schedules/<id> — 일정 한 건(참석자 포함). */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireRouteUserOrApiKey(request);
    if (!auth.ok) return auth.response;
    const { id } = await context.params;
    const { existing } = await loadExisting(id);
    return NextResponse.json({ data: existing });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * PATCH /api/schedules/<id> { title?, date?, time?, start_at?, end_at?, all_day?, category?, location?, description?, assignees? }
 * 만든 사람·참석자·관리자만. date 만 주면 시각은 그대로 두고 날짜만 옮긴다.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireRouteUserOrApiKey(request);
    if (!auth.ok) return auth.response;
    const { id } = await context.params;
    const { supabase, existing } = await loadExisting(id);
    if (!(await canEditSchedule(id, auth.actor.employee))) {
      return forbiddenResponse("이 일정은 만든 사람·참석자·관리자만 고칠 수 있습니다.");
    }

    const body = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {};

    if (body.title !== undefined) {
      const title = normalizeText(body.title);
      if (!title) throw new BadRequest("title 을 비울 수 없습니다");
      update.title = title.slice(0, 200);
    }
    if (body.description !== undefined) update.description = normalizeText(body.description);
    if (body.location !== undefined) update.location = normalizeText(body.location);
    if (body.category !== undefined) update.category = await normalizeCategory(supabase, body.category);
    if (body.project_id !== undefined) update.project_id = normalizeText(body.project_id);
    if (body.customer_id !== undefined) update.customer_id = normalizeText(body.customer_id);

    const touchesTime = ["start_at", "end_at", "time", "start_time", "end_time", "duration_min", "all_day"].some(
      (key) => body[key] !== undefined,
    );
    if (touchesTime) {
      const times = buildScheduleTimes(body.date !== undefined || body.start_at !== undefined ? body : {
        ...body,
        date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(existing.start_at)),
      });
      Object.assign(update, times);
    } else if (body.date !== undefined) {
      // 날짜만 바꾸면 같은 시각·같은 길이로 옮긴다.
      const date = normalizeText(body.date);
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequest("date 는 YYYY-MM-DD 여야 합니다");
      const oldDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(existing.start_at));
      const shift = new Date(`${date}T00:00:00+09:00`).getTime() - new Date(`${oldDate}T00:00:00+09:00`).getTime();
      update.start_at = new Date(new Date(existing.start_at).getTime() + shift).toISOString();
      update.end_at = new Date(new Date(existing.end_at).getTime() + shift).toISOString();
    }
    const startAt = (update.start_at as string | undefined) ?? existing.start_at;
    const endAt = (update.end_at as string | undefined) ?? existing.end_at;
    assertValidRange(startAt, endAt);

    const attendeeIds = await resolveAttendeeIds(supabase, body, auth.actor.employee);
    const finalAttendees = attendeeIds ?? existing.attendees.map((a) => a.employee_id);

    const merged = {
      title: (update.title as string | undefined) ?? existing.title,
      description: update.description !== undefined ? (update.description as string | null) : existing.description,
      start_at: startAt,
      end_at: endAt,
      all_day: (update.all_day as boolean | undefined) ?? existing.all_day,
      location: update.location !== undefined ? (update.location as string | null) : existing.location,
    };
    const { meta, warning } = await syncUpdateToGoogle(supabase, auth.actor, existing, merged, finalAttendees);

    if (Object.keys(update).length > 0 || Object.keys(meta).length > 0) {
      const { error } = await supabase
        .from("schedules")
        .update({ ...update, ...meta, sync_source: "local" })
        .eq("id", id);
      if (error) throw dbError(error);
    }
    if (attendeeIds !== undefined) await replaceAttendees(supabase, id, attendeeIds);

    const data = await selectSchedule(supabase, id);
    logInfo("UPDATE_SCHEDULE_API", `일정 수정: ${merged.title}`, { resource: "schedule", resource_id: id });
    return NextResponse.json({ data, warning });
  } catch (error) {
    return errorResponse(error);
  }
}

/** DELETE /api/schedules/<id> — 만든 사람·참석자·관리자만. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const auth = await requireRouteUserOrApiKey(request);
    if (!auth.ok) return auth.response;
    const { id } = await context.params;
    const { supabase, existing } = await loadExisting(id);
    if (!(await canEditSchedule(id, auth.actor.employee))) {
      return forbiddenResponse("이 일정은 만든 사람·참석자·관리자만 지울 수 있습니다.");
    }
    const warning = await syncDeleteToGoogle(supabase, auth.actor, existing);
    const { error } = await supabase.from("schedules").delete().eq("id", id);
    if (error) throw dbError(error);
    logInfo("DELETE_SCHEDULE_API", `일정 삭제: ${existing.title}`, { resource: "schedule", resource_id: id });
    return NextResponse.json({ deleted: true, data: existing, warning });
  } catch (error) {
    return errorResponse(error);
  }
}
