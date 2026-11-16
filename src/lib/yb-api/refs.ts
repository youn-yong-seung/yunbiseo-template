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

/** 찾는 대상이 없을 때 던진다. errorResponse 가 404 로 바꾼다. */
export class NotFound extends Error {}

export function errorResponse(error: unknown) {
  if (error instanceof BadRequest) return NextResponse.json({ error: error.message }, { status: 400 });
  if (error instanceof NotFound) return NextResponse.json({ error: error.message }, { status: 404 });
  const message = error instanceof Error ? error.message : "Unknown server error";
  return NextResponse.json({ error: message }, { status: 500 });
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

/** 직원 이름·uuid·"me"(API 키를 만든 직원)를 직원 uuid 로 바꾼다. */
export async function resolveEmployeeRef(supabase: Admin, ref: string, apiKeyOwnerName: string | null): Promise<string> {
  const value = ref.trim();
  if (UUID_RE.test(value)) return value;
  const name = value === "me" ? apiKeyOwnerName : value;
  if (!name) throw new BadRequest("API 키의 직원을 알 수 없어 'me'를 쓸 수 없습니다");
  const { data, error } = await supabase.from("employees").select("id").ilike("name", name).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new BadRequest(`employee not found: ${name}`);
  return data.id as string;
}

/**
 * API 를 부른 직원. API 키를 만든 직원 이름으로 찾고, 못 찾으면 관리자 → 첫 직원 순으로 정한다.
 * 할 일 작성자·메모 작성자·단계 변경자 기록에 쓴다.
 */
export async function resolveActor(
  supabase: Admin,
  createdByName: string | null,
): Promise<{ id: string; name: string } | null> {
  if (createdByName) {
    const { data } = await supabase.from("employees").select("id, name").eq("name", createdByName).maybeSingle();
    if (data?.id) return data as { id: string; name: string };
  }
  const { data: admin } = await supabase
    .from("employees")
    .select("id, name")
    .eq("employee_type", "관리자")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (admin?.id) return admin as { id: string; name: string };
  const { data: first } = await supabase
    .from("employees")
    .select("id, name")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (first as { id: string; name: string } | null) ?? null;
}
