import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  getAttendeeEmails,
  getGoogleCalendarClient,
  getGoogleCalendarId,
  updateGoogleCalendarEvent,
} from "@/lib/google-calendar";
import { getGoogleOAuthToken } from "@/lib/google-token";
import type { RouteActor } from "@/lib/route-auth";
import { BadRequest, UUID_RE, normalizeText, type Admin } from "@/lib/yb-api/refs";

/**
 * 일정 외부 API(/api/schedules, yb schedule·today) 공용 도구.
 * 웹 화면(/api/schedules/mutate)과 같은 테이블·같은 구글 캘린더 규칙을 쓴다:
 * - 로그인한 직원(API 키 주인)의 구글 토큰 → 없으면 관리자가 연결한 회사 공용 토큰 → 없으면 캘린더 없이 저장.
 * - 캘린더 쪽이 실패해도 일정은 저장하고 warning 으로 알려 준다.
 */

export const SCHEDULE_SELECT =
  "id, title, description, start_at, end_at, all_day, category, location, project_id, customer_id, lead_id, created_by, created_at, updated_at, recurrence_type, recurrence_group_id, google_event_id, google_calendar_id, google_meet_link, sync_source, attendees:schedule_attendees(employee_id, employees(id, name, department))";

export const DEFAULT_CATEGORIES = ["other", "meeting", "education", "content", "sales", "personal"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function parseBoolean(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return fallback;
}

function parseIso(value: unknown, field: string): string {
  const text = normalizeText(value);
  if (!text || Number.isNaN(new Date(text).getTime())) throw new BadRequest(`${field} 는 ISO 날짜시간이어야 합니다(예: 2026-11-25T14:00:00+09:00)`);
  return new Date(text).toISOString();
}

function kstDateTime(date: string, time: string) {
  const [h, m] = time.split(":");
  return new Date(`${date}T${h.padStart(2, "0")}:${m}:00+09:00`).toISOString();
}

/** start_at/end_at 또는 date(+time·start_time·end_time·duration_min·all_day)로 시간을 만든다. */
export function buildScheduleTimes(body: Record<string, unknown>) {
  const allDay = parseBoolean(body.all_day, false);

  if (body.start_at !== undefined || body.end_at !== undefined) {
    const startAt = parseIso(body.start_at, "start_at");
    const endAt = body.end_at !== undefined
      ? parseIso(body.end_at, "end_at")
      : new Date(new Date(startAt).getTime() + 60 * 60_000).toISOString();
    return { start_at: startAt, end_at: endAt, all_day: allDay };
  }

  const date = normalizeText(body.date);
  if (!date) throw new BadRequest("start_at/end_at 또는 date(YYYY-MM-DD)가 필요합니다");
  if (!DATE_RE.test(date)) throw new BadRequest("date 는 YYYY-MM-DD 여야 합니다");

  if (allDay) {
    return {
      start_at: new Date(`${date}T00:00:00+09:00`).toISOString(),
      end_at: new Date(`${date}T23:59:59+09:00`).toISOString(),
      all_day: true,
    };
  }

  const startTime = normalizeText(body.start_time ?? body.time);
  if (!startTime || !TIME_RE.test(startTime)) {
    throw new BadRequest("시간 일정은 time(HH:MM)이 필요합니다. 종일 일정이면 all_day=true");
  }
  const endTime = normalizeText(body.end_time);
  if (endTime && !TIME_RE.test(endTime)) throw new BadRequest("end_time 은 HH:MM 이어야 합니다");
  const startAt = kstDateTime(date, startTime);
  const minutes = Number.parseInt(String(body.duration_min ?? "60"), 10);
  const endAt = endTime
    ? kstDateTime(date, endTime)
    : new Date(new Date(startAt).getTime() + (Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 24 * 60) : 60) * 60_000).toISOString();
  return { start_at: startAt, end_at: endAt, all_day: false };
}

export function assertValidRange(startAt: string, endAt: string) {
  if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new BadRequest("끝나는 시각이 시작 시각보다 뒤여야 합니다");
  }
}

export async function normalizeCategory(supabase: Admin, value: unknown) {
  const requested = normalizeText(value) ?? "other";
  if (DEFAULT_CATEGORIES.includes(requested)) return requested;
  const { data } = await supabase.from("schedule_categories").select("value").eq("value", requested).maybeSingle();
  if (data?.value) return requested;
  throw new BadRequest(`category '${requested}' 가 없습니다. 쓸 수 있는 값: ${DEFAULT_CATEGORIES.join("|")} 또는 일정 유형 관리에 등록한 값`);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 담당자(참석자): attendee_ids(직원 id 배열) + assignees/assignee_names/assigned_to(이름·id·"me"). */
export async function resolveAttendeeIds(
  supabase: Admin,
  body: Record<string, unknown>,
  me: { id: string },
): Promise<string[] | undefined> {
  const raw = [body.attendee_ids, body.assignees, body.assignee_names, body.assigned_to].filter(
    (value) => value !== undefined && value !== null,
  );
  if (raw.length === 0) return undefined;
  const refs = raw
    .flatMap((value) => (Array.isArray(value) ? value : String(value).split(",")))
    .map((value) => String(value).trim())
    .filter(Boolean);
  const ids: string[] = [];
  for (const ref of refs) {
    let id: string | null = null;
    if (ref === "me" || ref === "나") id = me.id;
    else if (UUID_RE.test(ref)) {
      const { data } = await supabase.from("employees").select("id").eq("id", ref).maybeSingle();
      id = (data?.id as string | undefined) ?? null;
    } else {
      const { data } = await supabase.from("employees").select("id").ilike("name", escapeLike(ref)).limit(1).maybeSingle();
      id = (data?.id as string | undefined) ?? null;
    }
    if (!id) throw new BadRequest(`직원을 찾지 못했습니다: ${ref}`);
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export async function replaceAttendees(supabase: Admin, scheduleId: string, attendeeIds: string[]) {
  const { error: deleteError } = await supabase.from("schedule_attendees").delete().eq("schedule_id", scheduleId);
  if (deleteError) throw new Error(deleteError.message);
  if (attendeeIds.length === 0) return;
  const { error } = await supabase
    .from("schedule_attendees")
    .insert(attendeeIds.map((employee_id) => ({ schedule_id: scheduleId, employee_id })));
  if (error) throw new Error(error.message);
}

export async function selectSchedule(supabase: Admin, id: string) {
  const { data, error } = await supabase.from("schedules").select(SCHEDULE_SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

const CALENDAR_WARNING = "일정은 저장했지만 구글 캘린더에는 반영하지 못했습니다. 필요하면 Google 계정을 다시 연결하세요.";

/** 부른 직원 기준 구글 캘린더 클라이언트. 연동이 없으면 null(정상). */
async function calendarFor(supabase: Admin, actor: RouteActor) {
  if (!process.env.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET) return null;
  const token = actor.authUid
    ? await getGoogleOAuthToken(supabase, actor.authUid)
    : null;
  if (!token) return null;
  return getGoogleCalendarClient(token);
}

type ScheduleForGoogle = {
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location: string | null;
};

export async function syncCreateToGoogle(
  supabase: Admin,
  actor: RouteActor,
  schedule: ScheduleForGoogle,
  attendeeIds: string[],
  addGoogleMeet: boolean,
): Promise<{ meta: Record<string, unknown>; warning: string | null }> {
  try {
    const calendar = await calendarFor(supabase, actor);
    if (!calendar) return { meta: {}, warning: null };
    const meta = await createGoogleCalendarEvent({
      calendar,
      calendarId: getGoogleCalendarId(),
      schedule,
      attendeeEmails: await getAttendeeEmails(attendeeIds),
      addGoogleMeet,
    });
    return { meta, warning: null };
  } catch (error) {
    console.error("[schedules] google create", error instanceof Error ? error.message : error);
    return { meta: {}, warning: CALENDAR_WARNING };
  }
}

export async function syncUpdateToGoogle(
  supabase: Admin,
  actor: RouteActor,
  existing: { google_event_id: string | null; google_calendar_id: string | null },
  schedule: ScheduleForGoogle,
  attendeeIds: string[],
): Promise<{ meta: Record<string, unknown>; warning: string | null }> {
  try {
    const calendar = await calendarFor(supabase, actor);
    if (!calendar) return { meta: {}, warning: existing.google_event_id ? CALENDAR_WARNING : null };
    const calendarId = existing.google_calendar_id ?? getGoogleCalendarId();
    const attendeeEmails = await getAttendeeEmails(attendeeIds);
    const meta = existing.google_event_id
      ? await updateGoogleCalendarEvent({ calendar, calendarId, eventId: existing.google_event_id, schedule, attendeeEmails })
      : await createGoogleCalendarEvent({ calendar, calendarId, schedule, attendeeEmails });
    return { meta, warning: null };
  } catch (error) {
    console.error("[schedules] google update", error instanceof Error ? error.message : error);
    return { meta: {}, warning: CALENDAR_WARNING };
  }
}

export async function syncDeleteToGoogle(
  supabase: Admin,
  actor: RouteActor,
  existing: { google_event_id: string | null; google_calendar_id: string | null },
): Promise<string | null> {
  if (!existing.google_event_id) return null;
  try {
    const calendar = await calendarFor(supabase, actor);
    if (!calendar) return "일정은 지웠지만 구글 캘린더 연결이 없어 캘린더 쪽 일정은 남아 있습니다.";
    await deleteGoogleCalendarEvent({
      calendar,
      calendarId: existing.google_calendar_id ?? getGoogleCalendarId(),
      eventId: existing.google_event_id,
    });
    return null;
  } catch (error) {
    console.error("[schedules] google delete", error instanceof Error ? error.message : error);
    return "일정은 지웠지만 구글 캘린더에서는 지우지 못했습니다.";
  }
}
