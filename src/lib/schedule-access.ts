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
