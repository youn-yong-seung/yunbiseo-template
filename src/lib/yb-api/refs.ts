import { NextResponse } from "next/server";
import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * yb CLI 용 외부 API 가 같이 쓰는 도구들.
 * 사람이 부르기 쉬운 값(할 일 번호 2001, 프로젝트 번호 26-3, 직원 이름, "me")을 id 로 바꾼다.
 */

export type Admin = ReturnType<typeof createAdminClient>;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

export function parseDate(value: unknown, fieldName: string): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new BadRequest(`${fieldName} must be YYYY-MM-DD`);
  return text;
}

export function parseLimit(value: string | null, fallback: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** 사용자 입력이 잘못됐을 때 던진다. errorResponse 가 400 으로 바꾼다. */
export class BadRequest extends Error {}

/**
 * Supabase(PostgREST) 오류를 사용자에게 보여 줄 400 오류로 바꾼다. DB 원문은 응답에 싣지 않는다.
 */
export function dbError(error: { code?: string; message?: string } | null | undefined): BadRequest {
  if (error?.message) console.error("[db]", error.code ?? "", error.message);
  switch (error?.code) {
    case "22P02":
    case "22007":
    case "22008":
      return new BadRequest("값의 형식이 올바르지 않습니다(id·날짜·숫자를 확인하세요).");
    case "23505":
      return new BadRequest("이미 같은 값이 있습니다.");
    case "23503":
      return new BadRequest("연결하려는 대상(고객·프로젝트·직원 등)을 찾지 못했습니다.");
    case "23502":
      return new BadRequest("필수 값이 빠졌습니다.");
    case "23514":
      return new BadRequest("허용되지 않는 값입니다.");
    default:
      return new BadRequest("요청을 처리하지 못했습니다. 입력값을 확인하세요.");
  }
}

/** 찾는 대상이 없을 때 던진다. errorResponse 가 404 로 바꾼다. */
export class NotFound extends Error {}

export function errorResponse(error: unknown) {
  if (error instanceof BadRequest) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof NotFound) return NextResponse.json({ error: error.message }, { status: 404 });
  // 내부 오류 원문(DB 메시지 등)은 응답에 싣지 않고 서버 로그에만 남긴다.
  console.error("[api]", error);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/** "2001", "#2001" 같은 할 일 번호나 uuid 를 할 일 uuid 로 바꾼다. 없으면 null. */
export async function resolveTaskRef(supabase: Admin, ref: string): Promise<string | null> {
  const value = ref.trim().replace(/^#/, "");
  if (UUID_RE.test(value)) return value;
  if (!/^\d+$/.test(value)) return null;
  const { data, error } = await supabase.from("tasks").select("id").eq("task_no", Number(value)).maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.id as string | undefined) ?? null;
}

/** "26-3" 같은 프로젝트 번호나 uuid 를 프로젝트 uuid 로 바꾼다. 없으면 null. */
export async function resolveProjectRef(supabase: Admin, ref: string): Promise<string | null> {
  const value = decodeURIComponent(ref).trim();
  if (UUID_RE.test(value)) return value;
  const { data, error } = await supabase.from("projects").select("id").eq("project_number", value).maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.id as string | undefined) ?? null;
}

/** LIKE 패턴의 특수문자(% _ \\)를 글자 그대로 찾도록 바꾼다. */
function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 직원 이름·uuid·"me"(API 키를 만든 직원)를 직원 uuid 로 바꾼다. */
export async function resolveEmployeeRef(
  supabase: Admin,
  ref: string,
  me: { id: string; name: string } | null,
): Promise<string> {
  const value = ref.trim();
  if (value === "me" || value === "나") {
    if (!me) throw new BadRequest("API 키의 직원을 알 수 없어 'me'를 쓸 수 없습니다");
    return me.id;
  }
  if (UUID_RE.test(value)) return value;
  const { data, error } = await supabase
    .from("employees")
    .select("id")
    .ilike("name", escapeLike(value))
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new BadRequest(`employee not found: ${value}`);
  return data.id as string;
}

/**
 * API 를 부른 직원(API 키 주인). 할 일 작성자·메모 작성자·단계 변경자 기록에 쓴다.
 * 키는 항상 직원에 묶여 있으므로(validateApiKeyRecord) 다른 직원으로 대신 정하지 않는다.
 */
export function resolveActor(apiKey: { employee_id: string; created_by: string }): { id: string; name: string } {
  return { id: apiKey.employee_id, name: apiKey.created_by };
}
