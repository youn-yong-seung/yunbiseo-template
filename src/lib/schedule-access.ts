import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 일정을 고치거나 지울 수 있는지: 관리자, 만든 사람, 참석자(담당자). DB 정책 can_edit_schedule 과 같은 기준.
 */
export async function canEditSchedule(scheduleId: string, employee: { id: string; isAdmin: boolean }) {
  if (employee.isAdmin) return true;
  const admin = createAdminClient();
  const { data } = await admin
    .from("schedules")
    .select("created_by, schedule_attendees(employee_id)")
    .eq("id", scheduleId)
    .maybeSingle();
  if (!data) return true; // 없는 일정은 뒤에서 "찾지 못했습니다"로 처리한다.
  if (data.created_by === employee.id) return true;
  return ((data.schedule_attendees ?? []) as { employee_id: string }[]).some((row) => row.employee_id === employee.id);
}

/** 여러 일정을 한꺼번에 확인한다(반복 일정 묶음 수정·삭제용). 하나라도 권한 밖이면 false. */
export async function canEditAllSchedules(scheduleIds: string[], employee: { id: string; isAdmin: boolean }) {
  if (employee.isAdmin || scheduleIds.length === 0) return true;
  const admin = createAdminClient();
  const { data } = await admin
    .from("schedules")
    .select("id, created_by, schedule_attendees(employee_id)")
    .in("id", scheduleIds);
  if (!data || data.length !== new Set(scheduleIds).size) return false;
  return data.every(
    (row) =>
      row.created_by === employee.id ||
      ((row.schedule_attendees ?? []) as { employee_id: string }[]).some((a) => a.employee_id === employee.id),
  );
}
