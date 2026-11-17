-- 보안 재검토 반영 (2026-11-18) — 매입
-- 관리자·재무가 아니면 상태는 작성중(draft)·요청(requested)·취소(cancelled)만 쓸 수 있고,
-- 승인·지급 예정·지급완료된 건은 고치거나 지울 수 없다(INSERT·UPDATE·DELETE 모두). 상태 이력은 서버만 쓴다.

-- ─────────────────────────────────────────── 3. 매입 보호

DROP TRIGGER IF EXISTS trg_guard_expense_approval ON public.expenses;
DROP FUNCTION IF EXISTS public.guard_expense_approval();

CREATE OR REPLACE FUNCTION public.guard_expense_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  employee_statuses text[] := ARRAY['draft', 'requested', 'cancelled'];
  locked_statuses text[] := ARRAY['approved', 'scheduled', 'paid'];
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' OR public.is_finance_or_admin() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT (NEW.status = ANY (employee_statuses)) THEN
      RAISE EXCEPTION '승인·지급 상태의 매입은 관리자 또는 재무 담당만 등록할 수 있습니다.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = ANY (locked_statuses) THEN
    RAISE EXCEPTION '승인·지급된 매입은 관리자 또는 재무 담당만 고치거나 지울 수 있습니다.' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (NEW.status = ANY (employee_statuses)) THEN
    RAISE EXCEPTION '매입 승인·반려·지급 처리는 관리자 또는 재무 담당만 할 수 있습니다.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_expense_write ON public.expenses;
CREATE TRIGGER trg_guard_expense_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_write();

-- 상태 이력은 서버(service role)만 쓴다. 직원은 보기만.
DROP POLICY IF EXISTS "employees_insert" ON public.expense_status_history;
