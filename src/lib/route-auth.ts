import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 서버 라우트 인증 공통 도구.
 *
 * 원칙
 * - 로그인만으로는 부족하다. employees.auth_uid 로 연결된 "활성 직원"이어야 통과한다
 *   (Supabase 회원가입으로 만든 계정·비활성 직원은 막는다).
 * - API 키는 키를 만든 직원으로 동작한다. 직원이 비활성이면 키도 막힌다.
 * - 관리자 전용 기능은 requireRouteAdmin / actor.isAdmin 으로 서버에서 확인한다.
 */

export type RouteEmployee = {
  id: string;
  name: string;
  employee_type: string | null;
  is_finance: boolean;
  auth_uid: string | null;
  isAdmin: boolean;
};

export type RouteActor = {
  via: "session" | "api_key";
  employee: RouteEmployee;
  /** 로그인 세션이면 Supabase auth 사용자 id, API 키면 키 주인의 auth_uid(없을 수 있음) */
  authUid: string | null;
  apiKeyId: string | null;
};

type EmployeeRow = {
  id: string;
  name: string;
  employee_type: string | null;
  is_finance: boolean | null;
  auth_uid: string | null;
  is_active: boolean | null;
};

const EMPLOYEE_COLUMNS = "id, name, employee_type, is_finance, auth_uid, is_active";

export function toRouteEmployee(row: EmployeeRow): RouteEmployee {
  return {
    id: row.id,
    name: row.name,
    employee_type: row.employee_type,
    is_finance: Boolean(row.is_finance),
    auth_uid: row.auth_uid,
    isAdmin: row.employee_type === "관리자",
  };
}

/** 돈이 오가는 처리(세금계산서 발행·매입 승인·거래처 계좌 변경 등)를 할 수 있는 직원: 관리자 또는 재무 담당. */
export function canManageFinance(employee: Pick<RouteEmployee, "isAdmin" | "is_finance">): boolean {
  return employee.isAdmin || employee.is_finance;
}

/** auth 사용자 id 로 활성 직원을 찾는다. 없거나 비활성이면 null. */
export async function findActiveEmployeeByAuthUid(authUid: string): Promise<RouteEmployee | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("employees")
    .select(EMPLOYEE_COLUMNS)
    .eq("auth_uid", authUid)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return toRouteEmployee(data as EmployeeRow);
}

/**
 * 로그인 세션 확인. user 와 employee 가 둘 다 있어야 통과로 본다.
 * 로그인했지만 직원이 아니거나 비활성이면 user 를 null 로 돌려 401 이 되게 한다.
 */
export async function requireRouteUser(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  user: User | null;
  employee: RouteEmployee | null;
  authUnavailable: boolean;
}> {
  const supabase = await createClient();
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error || !user) {
      return {
        supabase,
        user: null,
        employee: null,
        authUnavailable: error ? isTransientAuthError(error) : false,
      };
    }

    const employee = await findActiveEmployeeByAuthUid(user.id);
    if (!employee) {
      return { supabase, user: null, employee: null, authUnavailable: false };
    }

    return { supabase, user, employee, authUnavailable: false };
  } catch {
    return { supabase, user: null, employee: null, authUnavailable: true };
  }
}

/** 관리자만 통과. 실패 응답(401/403/503)을 response 로 돌려준다. */
export async function requireRouteAdmin() {
  const result = await requireRouteUser();
  if (!result.user || !result.employee) {
    return { ok: false as const, response: createRouteAuthErrorResponse(result.authUnavailable) };
  }
  if (!result.employee.isAdmin) {
    return { ok: false as const, response: forbiddenResponse("관리자만 할 수 있습니다.") };
  }
  return { ok: true as const, ...result, user: result.user, employee: result.employee };
}

export function createRouteAuthErrorResponse(authUnavailable = false) {
  if (authUnavailable) {
    return NextResponse.json(
      { error: "Auth service unavailable" },
      { status: 503 }
    );
  }

  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function forbiddenResponse(message = "권한이 없습니다.") {
  return NextResponse.json({ error: "Forbidden", message }, { status: 403 });
}

function isTransientAuthError(error: { message?: string; status?: number }) {
  const msg = error.message?.toLowerCase() ?? "";

  if (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("timeout")
  ) {
    return true;
  }

  return Boolean(error.status && error.status >= 500);
}

function hasApiKeyHeader(request: Request) {
  if (request.headers.get("x-api-key")) return true;
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ");
}

/**
 * 웹 화면(로그인 세션)과 yb CLI(x-api-key) 둘 다 받는 API 용.
 * 통과하면 actor(부른 직원)를 돌려준다. API 키 헤더가 있으면 키만 본다(세션으로 넘어가지 않는다).
 */
export async function requireRouteUserOrApiKey(
  request: Request,
  { admin = false }: { admin?: boolean } = {}
): Promise<
  | { ok: true; actor: RouteActor; actorId: string | null; apiKeyName: string | null }
  | { ok: false; response: NextResponse }
> {
  let actor: RouteActor;

  if (hasApiKeyHeader(request)) {
    const { validateApiKeyRecord } = await import("@/lib/api-key");
    const record = await validateApiKeyRecord(request);
    if (!record) return { ok: false, response: createRouteAuthErrorResponse(false) };
    actor = {
      via: "api_key",
      employee: record.employee,
      authUid: record.employee.auth_uid,
      apiKeyId: record.id,
    };
  } else {
    const { user, employee, authUnavailable } = await requireRouteUser();
    if (!user || !employee) return { ok: false, response: createRouteAuthErrorResponse(authUnavailable) };
    actor = { via: "session", employee, authUid: user.id, apiKeyId: null };
  }

  if (admin && !actor.employee.isAdmin) {
    return { ok: false, response: forbiddenResponse("관리자만 할 수 있습니다.") };
  }

  return {
    ok: true,
    actor,
    // 기존 호출부 호환: 기록용 actor id 는 로그인 사용자 auth id(세션) 또는 null(API 키)
    actorId: actor.via === "session" ? actor.authUid : null,
    apiKeyName: actor.via === "api_key" ? actor.employee.name : null,
  };
}

/**
 * cron·외부 스케줄러용 비밀 확인. 비밀이 설정돼 있지 않으면 항상 거부한다(fail-closed).
 * Authorization: Bearer <CRON_SECRET> 만 받는다.
 */
export function verifyCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return false;
  const header = request.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return false;
  return safeEqual(header.slice(7).trim(), secret);
}

export function safeEqual(a: string, b: string): boolean {
  // 길이가 달라도 같은 시간 비교가 되도록 해시로 맞춘다.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
