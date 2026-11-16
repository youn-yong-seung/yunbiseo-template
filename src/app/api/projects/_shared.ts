import { PROJECT_STATUS_OPTIONS } from "@/lib/project-status";
import { BadRequest, NotFound, normalizeText, parseDate, type Admin } from "@/lib/yb-api/refs";

/** yb 가 읽는 모양: 유형 이름·고객 이름을 함께 싣는다. */
export const PROJECT_SELECT = "*, project_types(id, name), customers(id, name)";

export function parseProjectStatus(value: unknown): string {
  const status = normalizeText(value);
  if (!status || !(PROJECT_STATUS_OPTIONS as readonly string[]).includes(status)) {
    throw new BadRequest(`status must be one of ${PROJECT_STATUS_OPTIONS.join(", ")}`);
  }
  return status;
}

/** 프로젝트 유형 이름(예: 교육) → type_id. 없는 이름이면 가능한 이름을 알려 준다. */
async function resolveTypeId(supabase: Admin, value: unknown): Promise<string | null> {
  const name = normalizeText(value);
  if (!name) return null;
  const { data } = await supabase.from("project_types").select("id, name").order("sort_order");
  const match = (data ?? []).find((row) => row.name === name || row.id === name);
  if (!match) {
    const names = (data ?? []).map((row) => row.name).join(", ") || "(등록된 유형 없음)";
    throw new BadRequest(`project type not found: ${name}. 가능한 유형: ${names}`);
  }
  return match.id as string;
}

/**
 * 요청 본문에서 프로젝트 필드만 골라 검증한다(status 제외: 단계는 이력과 함께 따로 바꾼다).
 * 고객을 지정하면 고객 이름을 client 에도 넣는다(웹 화면과 같은 규칙).
 */
export async function pickProjectFields(supabase: Admin, body: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = normalizeText(body.name);
    if (!name) throw new BadRequest("name cannot be empty");
    fields.name = name;
  }
  if (body.description !== undefined) fields.description = normalizeText(body.description);
  if (body.manager !== undefined) {
    // 쓰기 전에 담당자 이름이 직원 목록에 있는지 먼저 확인한다(중간에 실패해 반만 저장되는 일을 막는다).
    const manager = normalizeText(body.manager);
    for (const name of (manager ?? "").split(",").map((n) => n.trim()).filter(Boolean)) {
      const { data } = await supabase.from("employees").select("id").eq("name", name).limit(1).maybeSingle();
      if (!data) throw new BadRequest(`manager not found in employees: ${name}`);
    }
    fields.manager = manager;
  }
  if (body.start_date !== undefined) fields.start_date = parseDate(body.start_date, "start_date");
  if (body.end_date !== undefined) fields.end_date = parseDate(body.end_date, "end_date");
  const typeValue = body.type ?? body.type_id;
  if (typeValue !== undefined) fields.type_id = await resolveTypeId(supabase, typeValue);
  if (body.customer_id !== undefined) {
    const customerId = normalizeText(body.customer_id);
    if (customerId) {
      const { data: customer } = await supabase.from("customers").select("id, name").eq("id", customerId).maybeSingle();
      if (!customer) throw new BadRequest(`customer not found: ${customerId}`);
      fields.customer_id = customer.id;
      fields.client = customer.name;
    } else {
      fields.customer_id = null;
    }
  }
  return fields;
}

export async function selectProject(supabase: Admin, id: string) {
  const { data, error } = await supabase.from("projects").select(PROJECT_SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Project not found");
  return data;
}

/** 바꾼 사람·사유와 함께 단계를 바꾼다. 이력은 DB 트리거가 남긴다. */
export async function setProjectStatus(
  supabase: Admin,
  projectId: string,
  status: string,
  note: string | null,
  actorEmployeeId: string | null,
) {
  const { error } = await supabase.rpc("set_project_status", {
    p_project_id: projectId,
    p_status: status,
    p_note: note,
    p_actor_employee_id: actorEmployeeId,
    p_source: "api",
  });
  if (error) throw new BadRequest(error.message);
}

/**
 * manager(쉼표로 여러 명 가능)에 적힌 직원 이름을 project_assignees 에도 맞춘다.
 * 웹 화면의 담당자 필터·집계는 project_assignees 를 본다. 이름이 직원 목록에 없으면 알려 준다.
 */
export async function syncProjectAssignees(supabase: Admin, projectId: string, manager: string | null) {
  const names = (manager ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  const ids: string[] = [];
  for (const name of names) {
    const { data } = await supabase.from("employees").select("id").eq("name", name).limit(1).maybeSingle();
    if (!data) throw new BadRequest(`manager not found in employees: ${name}`);
    ids.push(data.id as string);
  }
  const { error: delError } = await supabase.from("project_assignees").delete().eq("project_id", projectId);
  if (delError) throw new BadRequest(delError.message);
  if (ids.length > 0) {
    const { error } = await supabase
      .from("project_assignees")
      .insert([...new Set(ids)].map((employee_id) => ({ project_id: projectId, employee_id })));
    if (error) throw new BadRequest(error.message);
  }
}
