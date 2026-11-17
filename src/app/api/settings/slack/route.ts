import { requireRouteAdmin } from "@/lib/route-auth";
import { maskSecret, planSettingWrites } from "@/lib/secret-mask";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicErrorMessage } from "@/lib/safe-error";
import { getSlackSettings } from "@/lib/slack";

const SLACK_SETTING_KEYS = [
  "slack_bot_token",
  "slack_project_channel",
  "slack_schedule_channel",
  "slack_schedule_time",
  "slack_signing_secret",
] as const;

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn(body: Record<string, unknown> | null, key: string) {
  return Boolean(body && Object.prototype.hasOwnProperty.call(body, key));
}

export async function GET() {
  // 외부 서비스 키 설정은 관리자만 보고 바꾼다.
  const auth = await requireRouteAdmin();
  if (!auth.ok) return auth.response;

  const settings = await getSlackSettings();

  return Response.json({
    bot_token: maskSecret(settings.botToken),
    project_channel: settings.projectChannel ?? "",
    schedule_channel: settings.scheduleChannel ?? "",
    schedule_time: settings.scheduleTime ?? "07:00",
    signing_secret: maskSecret(settings.signingSecret),
  });
}

export async function PUT(request: Request) {
  // 외부 서비스 키 설정은 관리자만 보고 바꾼다.
  const auth = await requireRouteAdmin();
  if (!auth.ok) return auth.response;
  const supabase = createAdminClient();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const values = {
    ...(hasOwn(body, "bot_token") ? { slack_bot_token: asTrimmedString(body?.bot_token) } : {}),
    ...(hasOwn(body, "project_channel")
      ? { slack_project_channel: asTrimmedString(body?.project_channel) }
      : {}),
    ...(hasOwn(body, "schedule_channel")
      ? { slack_schedule_channel: asTrimmedString(body?.schedule_channel) }
      : {}),
    ...(hasOwn(body, "schedule_time") ? { slack_schedule_time: asTrimmedString(body?.schedule_time) } : {}),
    ...(hasOwn(body, "signing_secret")
      ? { slack_signing_secret: asTrimmedString(body?.signing_secret) }
      : {}),
  };

  const entries = Object.entries(values);

  if (entries.length === 0) {
    return Response.json({ success: true, keys: [] });
  }

  const { upsertRows, deleteKeys } = planSettingWrites(Object.fromEntries(entries));

  if (upsertRows.length > 0) {
    const { error } = await supabase.from("system_settings").upsert(upsertRows, { onConflict: "key" });
    if (error) {
      return Response.json({ error: publicErrorMessage(error) }, { status: 500 });
    }
  }

  if (deleteKeys.length > 0) {
    const { error } = await supabase.from("system_settings").delete().in("key", deleteKeys);
    if (error) {
      return Response.json({ error: publicErrorMessage(error) }, { status: 500 });
    }
  }

  return Response.json({ success: true, keys: SLACK_SETTING_KEYS });
}
