-- 2차 재검토 반영 (2026-11-18) — 매입 흐름
-- 관리자·재무가 아닌 직원(브라우저 직접 쓰기)은:
--   · 상태 변경은 작성중→요청·취소, 요청→작성중·취소, 반려→작성중·요청·취소만 (승인·지급예정·지급 건 취소 불가)
--   · 지급일·승인자·승인시각·요청자·요청시각·반려사유·취소시각·취소사유 같은 흐름 칸은 넣거나 바꿀 수 없다
--   · 승인·지급예정·지급·취소된 건은 고치거나 지울 수 없다
-- 취소(cancelled)된 건은 누구도 다른 상태로 되돌리지 않는다(필요하면 새 건으로).

CREATE OR REPLACE FUNCTION public.guard_expense_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  locked_statuses text[] := ARRAY['approved', 'scheduled', 'paid', 'cancelled'];
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- 취소된 건은 관리자·재무도 되살리지 않는다.
  IF TG_OP = 'UPDATE' AND OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION '취소된 매입은 다른 상태로 되돌릴 수 없습니다. 새로 등록하세요.' USING ERRCODE = '42501';
  END IF;

  IF public.is_finance_or_admin() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('draft', 'requested') THEN
      RAISE EXCEPTION '승인·지급 상태의 매입은 관리자 또는 재무 담당만 등록할 수 있습니다.' USING ERRCODE = '42501';
    END IF;
    IF NEW.payment_date IS NOT NULL OR NEW.approver_id IS NOT NULL OR NEW.approved_at IS NOT NULL
       OR NEW.requested_by IS NOT NULL OR NEW.requested_at IS NOT NULL OR NEW.rejected_reason IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_reason IS NOT NULL THEN
      RAISE EXCEPTION '지급일·승인·요청·반려·취소 정보는 직원이 직접 넣을 수 없습니다.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = ANY (locked_statuses) THEN
    RAISE EXCEPTION '승인·지급·취소된 매입은 관리자 또는 재무 담당만 고치거나 지울 수 있습니다.' USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('requested', 'cancelled'))
    OR (OLD.status = 'requested' AND NEW.status IN ('draft', 'cancelled'))
    OR (OLD.status = 'rejected' AND NEW.status IN ('draft', 'requested', 'cancelled'))
  ) THEN
    RAISE EXCEPTION '매입 승인·반려·지급 처리는 관리자 또는 재무 담당만 할 수 있습니다.' USING ERRCODE = '42501';
  END IF;

  IF NEW.payment_date IS DISTINCT FROM OLD.payment_date
     OR NEW.approver_id IS DISTINCT FROM OLD.approver_id
     OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason
     OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
     OR NEW.cancelled_reason IS DISTINCT FROM OLD.cancelled_reason THEN
    RAISE EXCEPTION '지급일·승인·요청·반려·취소 정보는 직원이 직접 바꿀 수 없습니다.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_expense_write() FROM PUBLIC, anon, authenticated;
