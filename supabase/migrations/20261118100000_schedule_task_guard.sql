-- 보안 재검토 반영 (2026-11-18) — 일정·할 일
-- 반복 일정 묶음(recurrence_group_id): 남이 만든 일정이 들어 있는 묶음 id 를 붙이거나 바꾸지 못하게 한다.
-- (남의 묶음 id 를 붙인 내 일정을 만든 뒤 "묶음 전체 삭제"로 남의 일정을 지울 수 있었다.)
-- 할 일·일정의 만든 사람(created_by)은 관리자만 바꾼다.

-- ─────────────────────────────────────────── 1·2. 일정·할 일 보호 트리거

CREATE OR REPLACE FUNCTION public.guard_schedule_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 서버(service role)는 API 에서 권한을 확인한 뒤 쓴다. 브라우저에서 직접 쓰는 경우만 검사한다.
  IF coalesce(auth.role(), '') <> 'authenticated' OR public.is_admin_employee() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION '일정을 만든 사람은 관리자만 바꿀 수 있습니다.' USING ERRCODE = '42501';
  END IF;

  IF NEW.recurrence_group_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.recurrence_group_id IS DISTINCT FROM OLD.recurrence_group_id)
     AND EXISTS (
       SELECT 1 FROM public.schedules s
       WHERE s.recurrence_group_id = NEW.recurrence_group_id
         AND s.id <> NEW.id
         AND NOT public.can_edit_schedule(s.id)
     ) THEN
    RAISE EXCEPTION '다른 사람의 반복 일정 묶음에는 일정을 넣을 수 없습니다.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_schedule_write ON public.schedules;
CREATE TRIGGER trg_guard_schedule_write
  BEFORE INSERT OR UPDATE ON public.schedules
  FOR EACH ROW EXECUTE FUNCTION public.guard_schedule_write();

CREATE OR REPLACE FUNCTION public.guard_task_creator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') = 'authenticated'
     AND NEW.created_by IS DISTINCT FROM OLD.created_by
     AND NOT public.is_admin_employee() THEN
    RAISE EXCEPTION '할 일을 만든 사람은 관리자만 바꿀 수 있습니다.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_task_creator ON public.tasks;
CREATE TRIGGER trg_guard_task_creator
  BEFORE UPDATE OF created_by ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.guard_task_creator();
