-- 2차 재검토 반영 (2026-11-18) — 일정·할 일 규칙
-- 1. 반복 정보(recurrence_type·recurrence_group_id·recurrence_end_date)는 서버만 정한다.
--    브라우저에서 직접 넣거나 바꾸면 거부(관리자 포함, 웹 화면은 서버 API 로 반복 일정을 만든다).
-- 2. 만든 사람(created_by)이 비어 있는 할 일은 새로 만들 수 없고, 예전 데이터의 그런 할 일은 관리자·담당자만 고친다.
-- 3. 트리거 함수의 실행 권한을 PUBLIC 에서 거둔다.

CREATE OR REPLACE FUNCTION public.guard_schedule_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.recurrence_group_id IS NOT NULL OR coalesce(NEW.recurrence_type, 'none') <> 'none'
       OR NEW.recurrence_end_date IS NOT NULL THEN
      RAISE EXCEPTION '반복 일정은 일정 화면(서버)에서만 만들 수 있습니다.' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NEW.recurrence_group_id IS DISTINCT FROM OLD.recurrence_group_id
       OR NEW.recurrence_type IS DISTINCT FROM OLD.recurrence_type
       OR NEW.recurrence_end_date IS DISTINCT FROM OLD.recurrence_end_date THEN
      RAISE EXCEPTION '반복 정보는 일정 화면(서버)에서만 바꿀 수 있습니다.' USING ERRCODE = '42501';
    END IF;
    IF NEW.created_by IS DISTINCT FROM OLD.created_by AND NOT public.is_admin_employee() THEN
      RAISE EXCEPTION '일정을 만든 사람은 관리자만 바꿀 수 있습니다.' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.can_edit_task(p_task_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.is_admin_employee() OR EXISTS (
    SELECT 1 FROM public.tasks t
    WHERE t.id = p_task_id
      AND public.current_employee_id() IS NOT NULL
      AND (
        t.created_by = public.current_employee_id()
        OR t.assigned_to = public.current_employee_id()
        OR EXISTS (
          SELECT 1 FROM public.task_assignees ta
          WHERE ta.task_id = t.id AND ta.employee_id = public.current_employee_id()
        )
      )
  )
$$;

DROP POLICY IF EXISTS "employees_insert" ON public.tasks;
CREATE POLICY "employees_insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_employee()
    AND created_by IS NOT NULL
    AND (created_by = public.current_employee_id() OR public.is_admin_employee())
  );

REVOKE ALL ON FUNCTION public.guard_schedule_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_task_creator() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_expense_write() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_note_author_name() FROM PUBLIC, anon, authenticated;
-- 앞으로 만드는 함수도 PUBLIC 실행 권한 없이 시작한다(스키마 한정이 아닌 전체 기본값).
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
