import { calendar_v3, google } from "googleapis";
import { getOAuthClient } from "@/lib/gmail";
import { createAdminClient } from "@/lib/supabase/admin";

const API_TIMEOUT_MS = 30_000;

type GoogleToken = {
  email: string;
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  onTokenRefreshed?: (newAccessToken: string, newExpiry: number) => void | Promise<void>;
};

export function getGoogleCalendarId() {
  return process.env.GOOGLE_CALENDAR_SYNC_CALENDAR_ID ?? "";
}

const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000; // 만료 5분 전부터 선제 갱신

export async function getGoogleCalendarClient(token: GoogleToken) {
  const client = getOAuthClient();
  client.setCredentials({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry_date: token.expiryDate,
  });

  // 토큰 갱신 저장은 프로액티브 갱신에서 await로 처리하므로
  // 이벤트 핸들러에서는 프로액티브 갱신을 건너뛴 경우(API 호출 중 자동 갱신)만 저장
  let proactiveRefreshDone = false;

  client.on("tokens", (tokens) => {
    if (proactiveRefreshDone) return; // 이미 저장 완료
    if (tokens.access_token && token.onTokenRefreshed) {
      token
        .onTokenRefreshed(
          tokens.access_token,
          tokens.expiry_date ?? Date.now() + 3600_000
        )
        ?.catch((err: unknown) => {
          console.error("[GoogleCalendar] 자동 토큰 갱신 저장 실패:", err);
        });
    }
  });

  if (!token.expiryDate || isNaN(token.expiryDate) || token.expiryDate < Date.now() + TOKEN_REFRESH_MARGIN_MS) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      proactiveRefreshDone = true;
      if (credentials.access_token && token.onTokenRefreshed) {
        await token.onTokenRefreshed(
          credentials.access_token,
          credentials.expiry_date ?? Date.now() + 3600_000
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const lower = errMsg.toLowerCase();
      if (lower.includes("invalid_client")) {
        throw new Error("invalid_client: Google OAuth 클라이언트 인증 정보가 유효하지 않습니다. 환경변수(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET)를 확인하거나 Google 계정을 다시 연결해주세요.");
      }
      if (lower.includes("invalid_grant") || lower.includes("token has been expired") || lower.includes("token has been revoked")) {
        throw new Error("insufficient_permissions: Google 인증이 만료되었습니다. Google 계정을 다시 연결해주세요.");
      }
      throw new Error(`Google Calendar 토큰 갱신 실패: ${errMsg}`);
    }
  }

  return google.calendar({
    version: "v3",
    auth: client,
    timeout: API_TIMEOUT_MS,
  });
}

type LocalScheduleForGoogle = {
  title: string;
  description?: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  location?: string | null;
};

function formatGoogleAllDayDate(isoString: string) {
  return new Date(isoString).toISOString().slice(0, 10);
}

function addDaysToDateString(dateString: string, days: number) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildGoogleEvent(
  schedule: LocalScheduleForGoogle,
  attendeeEmails: string[] = [],
  addGoogleMeet = false,
): calendar_v3.Schema$Event {
  return {
    summary: schedule.title,
    description: schedule.description ?? undefined,
    location: schedule.location ?? undefined,
    attendees: attendeeEmails.map((email) => ({ email })),
    ...(addGoogleMeet
      ? {
          conferenceData: {
            createRequest: {
              requestId: crypto.randomUUID(),
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
        }
      : {}),
    ...(schedule.all_day
      ? {
          start: { date: formatGoogleAllDayDate(schedule.start_at) },
          end: { date: addDaysToDateString(formatGoogleAllDayDate(schedule.end_at), 1) },
        }
      : {
          start: { dateTime: schedule.start_at },
          end: { dateTime: schedule.end_at },
        }),
  };
}

export async function getAttendeeEmails(employeeIds: string[]) {
  if (employeeIds.length === 0) return [];

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("employees")
    .select("email")
    .in("id", employeeIds);

  if (error) {
    throw new Error(`일정 참석자 이메일 조회 실패: ${error.message}`);
  }

  return (data ?? [])
    .map((row) => row.email)
    .filter((email): email is string => Boolean(email));
}

export async function createGoogleCalendarEvent(params: {
  calendar: calendar_v3.Calendar;
  calendarId: string;
  schedule: LocalScheduleForGoogle;
  attendeeEmails?: string[];
  addGoogleMeet?: boolean;
}) {
  const addMeet = params.addGoogleMeet ?? false;
  const response = await params.calendar.events.insert({
    calendarId: params.calendarId,
    requestBody: buildGoogleEvent(params.schedule, params.attendeeEmails, addMeet),
    ...(addMeet ? { conferenceDataVersion: 1 } : {}),
  });

  return {
    google_event_id: response.data.id ?? null,
    google_event_status: response.data.status ?? "confirmed",
    google_etag: response.data.etag ?? null,
    google_updated_at: response.data.updated ?? null,
    google_calendar_id: params.calendarId,
    google_meet_link: response.data.hangoutLink ?? null,
    sync_source: "local" as const,
  };
}

export async function updateGoogleCalendarEvent(params: {
  calendar: calendar_v3.Calendar;
  calendarId: string;
  eventId: string;
  schedule: LocalScheduleForGoogle;
  attendeeEmails?: string[];
}) {
  const response = await params.calendar.events.update({
    calendarId: params.calendarId,
    eventId: params.eventId,
    requestBody: buildGoogleEvent(params.schedule, params.attendeeEmails),
  });

  return {
    google_event_id: response.data.id ?? params.eventId,
    google_event_status: response.data.status ?? "confirmed",
    google_etag: response.data.etag ?? null,
    google_updated_at: response.data.updated ?? null,
    google_calendar_id: params.calendarId,
    sync_source: "local" as const,
  };
}

export async function deleteGoogleCalendarEvent(params: {
  calendar: calendar_v3.Calendar;
  calendarId: string;
  eventId: string;
}) {
  await params.calendar.events.delete({
    calendarId: params.calendarId,
    eventId: params.eventId,
  });
}
