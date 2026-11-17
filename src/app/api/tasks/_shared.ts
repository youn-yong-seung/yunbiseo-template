import { BadRequest, UUID_RE, normalizeText, type Admin } from "@/lib/yb-api/refs";

export const TASK_STATUSES = ["백로그", "할 일", "진행중", "완료", "취소"] as const;
export const TASK_PRIORITIES = ["높음", "보통", "낮음"] as const;

/** yb 가 읽는 모양: 프로젝트 번호와 담당자 이름을 함께 싣는다. */
export const TASK_SELECT =
  "*, projects(id, project_number, name), assignees:task_assignees(id, employee_id, employees(id, name, department))";

export function parseStatus(value: unknown, fallback: string): string {
  const status = normalizeText(value) ?? fallback;
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequest(`status must be one of ${TASK_STATUSES.join(", ")}`);
  }
  return status;
}

export function parsePriority(value: unknown, fallback: string): string {
  const priority = normalizeText(value) ?? fallback;
  if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) {
    throw new BadRequest(`priority must be one of ${TASK_PRIORITIES.join(", ")}`);
  }
  return priority;
}

export function parseEstimatedMinutes(value: unknown, fieldName = "estimated_minutes"): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) throw new BadRequest(`${fieldName} must be an integer`);
  return parsed;
}

/** 담당자 이름·uuid(하나 또는 배열)를 직원 uuid 목록으로. 값을 안 주면 undefined(=바꾸지 않음). */
export async function resolveAssigneeIds(supabase: Admin, assignees: unknown): Promise<string[] | undefined> {
  if (assignees === undefined) return undefined;
  const values = (Array.isArray(assignees) ? assignees : String(assignees ?? "").split(","))
    .map(normalizeText)
    .filter((v): v is string => Boolean(v));

  const ids: string[] = [];
  for (const value of values) {
    if (UUID_RE.test(value)) {
      ids.push(value);
      continue;
    }
    const { data, error } = await supabase.from("employees").select("id").ilike("name", value).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new BadRequest(`assignee not found: ${value}`);
    ids.push(data.id as string);
  }
  return [...new Set(ids)];
}

export async function selectTask(supabase: Admin, id: string) {
  const { data, error } = await supabase.from("tasks").select(TASK_SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * 할 일을 고치거나 지울 수 있는지: 관리자, 만든 사람, 담당자(assigned_to·공동 담당), 만든 사람 기록이 없는 옛 할 일.
 * DB 정책 public.can_edit_task 와 같은 기준이다. 안 되면 Forbidden 을 던진다.
 */
export class Forbidden extends Error {}

export async function assertCanEditTask(
  supabase: Admin,
  taskId: string,
  employee: { id: string; isAdmin: boolean },
) {
  if (employee.isAdmin) return;
  const { data: task } = await supabase
    .from("tasks")
    .select("created_by, assigned_to, task_assignees(employee_id)")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return; // 없는 할 일은 뒤에서 404 로 처리한다.
  const assignees = ((task.task_assignees ?? []) as { employee_id: string }[]).map((row) => row.employee_id);
  const ok =
    task.created_by === null ||
    task.created_by === employee.id ||
    task.assigned_to === employee.id ||
    assignees.includes(employee.id);
  if (!ok) throw new Forbidden("이 할 일은 만든 사람·담당자·관리자만 고치거나 지울 수 있습니다.");
}
