import { createHash } from "crypto";
import { headers } from "next/headers";
import { clientIp } from "@/lib/client-ip";
import { createAdminClient } from "@/lib/supabase/admin";

interface LogOptions {
  resource?: string;
  resource_id?: string;
  actor_id?: string;
  actor_name?: string;
  details?: Record<string, unknown>;
}

async function requestHeaders(): Promise<Headers | null> {
  try {
    return await headers();
  } catch {
    return null;
  }
}

/**
 * API 키로 부른 요청이면 키 주인 직원을 기록자로 쓴다(호출부가 actor 를 안 넘겨도 비지 않게).
 * 키 검증은 라우트가 이미 했다. 여기서는 활성 키·활성 직원일 때만 이름을 붙인다.
 */
async function resolveApiKeyActor(h: Headers | null): Promise<{ id: string; name: string } | null> {
  if (!h) return null;
  try {
    const auth = h.get("authorization");
    const key = (h.get("x-api-key") ?? (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "")).trim();
    if (!key || key.length > 200) return null;
    const { data } = await createAdminClient()
      .from("api_keys")
      .select("employees!api_keys_employee_id_fkey(id, name, is_active)")
      .eq("key_hash", createHash("sha256").update(key).digest("hex"))
      .eq("is_active", true)
      .maybeSingle();
    const employee = (data as { employees?: { id: string; name: string; is_active: boolean | null } | null } | null)?.employees;
    return employee && employee.is_active === true ? { id: employee.id, name: employee.name } : null;
  } catch {
    return null;
  }
}

async function resolveActor(authUid: string): Promise<{ id: string; name: string } | null> {
  try {
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("employees")
      .select("id, name")
      .eq("auth_uid", authUid)
      .maybeSingle();
    return data;
  } catch {
    return null;
  }
}

async function writeLog(
  level: "INFO" | "ERROR",
  action: string,
  message: string,
  opts?: LogOptions
) {
  try {
    const supabase = createAdminClient();
    // 요청 헤더는 처음 한 번만 읽는다(기록은 응답 뒤에 끝날 수 있다).
    const h = await requestHeaders();
    // 믿을 수 있는 헤더 순서는 clientIp 에 있다(Vercel 이면 플랫폼이 채우는 헤더).
    const ip = h ? clientIp(h) : null;

    let actorId = opts?.actor_id ?? null;
    let actorName = opts?.actor_name ?? null;

    // If we have an auth_uid in actor_id but no name, resolve it
    if (actorId && !actorName) {
      const actor = await resolveActor(actorId);
      if (actor) {
        actorName = actor.name;
        actorId = actor.id;
      }
    }

    // API 키 요청은 키 주인 직원으로 남긴다.
    if (!actorId) {
      const actor = await resolveApiKeyActor(h);
      if (actor) {
        actorId = actor.id;
        actorName = actor.name;
      }
    }

    supabase
      .from("app_logs")
      .insert({
        level,
        action,
        message,
        resource: opts?.resource ?? null,
        resource_id: opts?.resource_id ?? null,
        actor_id: actorId,
        actor_name: actorName,
        ip_address: ip,
        details: opts?.details ?? null,
      })
      .then();
  } catch {
    // fire-and-forget: never throw
  }
}

export function logInfo(action: string, message: string, opts?: LogOptions) {
  writeLog("INFO", action, message, opts);
}

export function logError(action: string, message: string, opts?: LogOptions) {
  writeLog("ERROR", action, message, opts);
}
