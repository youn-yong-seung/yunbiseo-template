-- 4차 보안 재검토 반영 (2026-11-19)
--
-- 1. 볼타로 발행(중)인 매출: 관리자 외에는 지우지 못하고, 프로젝트·제목·품목명·매출일도 바꾸지 못한다
-- 2. 로그인 실패 잠금을 "접속한 곳(IP 또는 브라우저) + 계정" 단위로 센다
--    · 같은 곳에서 15분 안에 5번 틀리면 그곳에서만 15분 막힌다(남이 아이디만 알고 계정을 잠그지 못하게)
--    · 계정 전체로는 15분 안에 50번 틀렸을 때만 15분 잠근다(여러 IP 로 나눠 맞혀 보는 공격 방어).
--      이 잠금은 토큰 발급 훅도 보므로 Supabase 로 직접 로그인하는 길도 막힌다.
--    · 속도 제한(check_login_rate): IP 를 모르면(프록시 설정 전) 모두가 한 칸을 같이 쓰지 않게 IP 칸을 건너뛰고
--      IP+아이디 칸만 더 느슨하게 센다
-- 3. 매입: 관리자·재무가 아니면 다른 직원이 요청한 매입(요청·반려·되돌린 작성중)을 고치거나 지우지 못한다
-- 4. 거래처(고객) 계좌(은행·계좌번호·예금주) 변경은 관리자·재무만
-- 5. API 키는 모두 만료일이 있어야 한다. 만료일 없는 옛 키에는 발급일 + 90일(이미 지났으면 지금부터 30일 유예)
-- 6. 입금 자동 연결 트리거가 uuid min() 오류로 연결 안 된 입금 저장을 모두 실패시키던 문제 수정

-- ─────────────────────────────────────────── 1. 볼타 발행 매출 보호

CREATE OR REPLACE FUNCTION public.guard_revenue_tax_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 서버(service_role: 발행 API·볼타 웹훅)와 DB 관리 작업은 통과.
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- 국세청에 넘어갔거나 넘어가는 중인 매출은 관리자만 지운다(지우면 발행 기록과 장부가 어긋난다).
    IF OLD.tax_invoice_issue_status IN ('issuing', 'issued') AND NOT public.is_admin_employee() THEN
      RAISE EXCEPTION '볼타로 발행(중)인 매출은 관리자만 지울 수 있습니다.' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  -- 발행 추적 칸은 서버(발행 API·볼타 웹훅)만 쓴다.
  IF TG_OP = 'INSERT' THEN
    IF NEW.tax_invoice_issue_status IS NOT NULL OR NEW.tax_invoice_issuance_key IS NOT NULL
       OR NEW.tax_invoice_client_reference_id IS NOT NULL THEN
      RAISE EXCEPTION '세금계산서 발행 상태는 서버만 기록합니다.' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tax_invoice_issue_status IS DISTINCT FROM OLD.tax_invoice_issue_status
     OR NEW.tax_invoice_issuance_key IS DISTINCT FROM OLD.tax_invoice_issuance_key
     OR NEW.tax_invoice_client_reference_id IS DISTINCT FROM OLD.tax_invoice_client_reference_id
     OR NEW.tax_invoice_issued_at IS DISTINCT FROM OLD.tax_invoice_issued_at
     OR NEW.tax_invoice_nts_transaction_id IS DISTINCT FROM OLD.tax_invoice_nts_transaction_id THEN
    RAISE EXCEPTION '세금계산서 발행 상태는 서버만 기록합니다.' USING ERRCODE = '42501';
  END IF;

  IF OLD.tax_invoice_issue_status IN ('issuing', 'issued') AND (
       NEW.is_tax_invoice_issued IS DISTINCT FROM OLD.is_tax_invoice_issued
    OR NEW.tax_invoice_date IS DISTINCT FROM OLD.tax_invoice_date
    OR NEW.tax_invoice_not_required IS DISTINCT FROM OLD.tax_invoice_not_required
    OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
    OR NEW.supply_amount IS DISTINCT FROM OLD.supply_amount
    OR NEW.vat_amount IS DISTINCT FROM OLD.vat_amount
  ) THEN
    RAISE EXCEPTION '볼타로 발행(중)인 매출은 금액·발행 여부·발행일을 바꿀 수 없습니다.' USING ERRCODE = '42501';
  END IF;

  -- 발행된 세금계산서와 이어진 핵심 칸(어느 프로젝트·고객의 무엇인지)은 관리자만 바꾼다.
  -- 입금 여부·입금일·메모처럼 발행 뒤에도 바뀌는 칸은 그대로 둔다.
  IF OLD.tax_invoice_issue_status IN ('issuing', 'issued') AND NOT public.is_admin_employee() AND (
       NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.product_name IS DISTINCT FROM OLD.product_name
    OR NEW.revenue_date IS DISTINCT FROM OLD.revenue_date
  ) THEN
    RAISE EXCEPTION '볼타로 발행(중)인 매출의 프로젝트·제목·품목명·매출일은 관리자만 바꿀 수 있습니다.' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_revenue_tax_invoice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_revenues_guard_tax_invoice ON public.revenues;
CREATE TRIGGER trg_revenues_guard_tax_invoice
  BEFORE INSERT OR UPDATE OR DELETE ON public.revenues
  FOR EACH ROW EXECUTE FUNCTION public.guard_revenue_tax_invoice();

-- ─────────────────────────────────────────── 2. 로그인 실패 잠금

-- 시도 기록: 비밀번호를 확인하기 전에 한 줄 넣고(예약), 성공하면 그 곳의 줄을 지운다.
-- 그래서 남은 줄 = 실패(또는 진행 중) 횟수다. client_key 는 'ip:<IP>' 또는 'browser:<쿠키 값>'.
CREATE TABLE IF NOT EXISTS public.login_failures (
  id bigserial PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  client_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_failures_pair ON public.login_failures (employee_id, client_key, created_at);
CREATE INDEX IF NOT EXISTS idx_login_failures_employee ON public.login_failures (employee_id, created_at);
ALTER TABLE public.login_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_failures FROM anon, authenticated;

DROP FUNCTION IF EXISTS public.reserve_login_attempt(uuid);
DROP FUNCTION IF EXISTS public.record_login_failure(uuid);

-- true 면 비밀번호를 확인해도 된다. false 면 이 곳에서 막혔거나(5번) 계정 전체가 잠겼다(50번).
CREATE OR REPLACE FUNCTION public.reserve_login_attempt(p_employee_id uuid, p_client_key text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  locked_until timestamptz;
  ckey text := left(coalesce(nullif(btrim(p_client_key), ''), 'none'), 200);
  pair_count integer;
  total_count integer;
BEGIN
  -- 같은 계정의 시도는 한 줄로 세운다(동시에 여러 번 보내도 5번을 넘지 않는다).
  SELECT e.login_locked_until INTO locked_until
  FROM public.employees e
  WHERE e.id = p_employee_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF locked_until IS NOT NULL AND locked_until > now() THEN
    RETURN false;
  END IF;

  DELETE FROM public.login_failures WHERE created_at < now() - interval '1 hour';

  SELECT count(*) INTO pair_count FROM public.login_failures
    WHERE employee_id = p_employee_id AND client_key = ckey AND created_at > now() - interval '15 minutes';
  IF pair_count >= 5 THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO total_count FROM public.login_failures
    WHERE employee_id = p_employee_id AND created_at > now() - interval '15 minutes';
  IF total_count >= 50 THEN
    UPDATE public.employees SET login_locked_until = now() + interval '15 minutes' WHERE id = p_employee_id;
    RETURN false;
  END IF;

  INSERT INTO public.login_failures (employee_id, client_key) VALUES (p_employee_id, ckey);
  UPDATE public.employees
  SET failed_login_count = total_count + 1,
      last_failed_login_at = now()
  WHERE id = p_employee_id;
  RETURN true;
END;
$$;

-- 예약한 시도가 실패로 끝났을 때: 줄은 이미 들어가 있으니 계정 전체 횟수만 보고 50번이면 잠근다.
-- 돌려주는 값은 계정 전체의 최근 15분 실패 횟수(직원 화면 표시용).
CREATE OR REPLACE FUNCTION public.record_login_failure(p_employee_id uuid, p_client_key text DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  total_count integer;
BEGIN
  SELECT count(*) INTO total_count FROM public.login_failures
    WHERE employee_id = p_employee_id AND created_at > now() - interval '15 minutes';
  UPDATE public.employees
  SET failed_login_count = total_count,
      last_failed_login_at = now(),
      login_locked_until = CASE WHEN total_count >= 50 THEN now() + interval '15 minutes' ELSE login_locked_until END
  WHERE id = p_employee_id;
  RETURN total_count;
END;
$$;

-- 로그인에 성공하면 그 곳의 실패 기록을 지운다(다른 곳의 기록은 남긴다: 분산 공격 횟수는 계속 센다).
CREATE OR REPLACE FUNCTION public.clear_login_failures(p_employee_id uuid, p_client_key text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  DELETE FROM public.login_failures
  WHERE employee_id = p_employee_id
    AND client_key = left(coalesce(nullif(btrim(p_client_key), ''), 'none'), 200)
$$;

REVOKE ALL ON FUNCTION public.reserve_login_attempt(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_login_failure(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_login_failures(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_login_attempt(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_login_failure(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_login_failures(uuid, text) TO service_role;

-- 이번 배포 전 규칙(계정 5번)으로 잠긴 계정은 풀어 준다. 새 규칙은 50번에서만 계정 전체를 잠근다.
UPDATE public.employees
SET login_locked_until = NULL
WHERE login_locked_until IS NOT NULL AND login_locked_until > now();

-- 속도 제한(5분 창)
--  · IP 를 알 때: IP 하나 30번(여러 아이디 포함), IP+아이디 10번
--  · IP 를 모를 때(p_ip NULL): IP 칸은 세지 않고(모두가 한 칸을 같이 써서 전원이 막히지 않게) IP 모름+아이디 30번
--  · 아이디 하나(모든 곳 합계) 100번: Supabase 서버 전체 한도를 한 계정 공격이 다 쓰지 못하게
CREATE OR REPLACE FUNCTION public.check_login_rate(p_ip text, p_login_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ip_value text := nullif(btrim(coalesce(p_ip, '')), '');
  key_value text := coalesce(p_login_key, '');
  ip_count integer := 0;
  pair_count integer;
  key_count integer;
BEGIN
  IF ip_value IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(7101, hashtext(ip_value));
  END IF;
  PERFORM pg_advisory_xact_lock(7102, hashtext(key_value));

  DELETE FROM public.login_attempt_log WHERE created_at < now() - interval '30 minutes';

  IF ip_value IS NOT NULL THEN
    SELECT count(*) INTO ip_count FROM public.login_attempt_log
      WHERE ip = ip_value AND created_at > now() - interval '5 minutes';
    SELECT count(*) INTO pair_count FROM public.login_attempt_log
      WHERE ip = ip_value AND login_key = key_value AND created_at > now() - interval '5 minutes';
    IF ip_count >= 30 OR pair_count >= 10 THEN
      RETURN false;
    END IF;
  ELSE
    SELECT count(*) INTO pair_count FROM public.login_attempt_log
      WHERE ip IS NULL AND login_key = key_value AND created_at > now() - interval '5 minutes';
    IF pair_count >= 30 THEN
      RETURN false;
    END IF;
  END IF;

  SELECT count(*) INTO key_count FROM public.login_attempt_log
    WHERE login_key = key_value AND created_at > now() - interval '5 minutes';
  IF key_count >= 100 THEN
    RETURN false;
  END IF;

  INSERT INTO public.login_attempt_log (ip, login_key) VALUES (ip_value, key_value);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.check_login_rate(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_login_rate(text, text) TO service_role;

-- 예전 코드가 IP 를 모를 때 넣던 'unknown' 기록은 새 규칙과 섞이지 않게 지운다.
DELETE FROM public.login_attempt_log WHERE ip = 'unknown';

-- ─────────────────────────────────────────── 3. 매입: 요청한 사람만

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

  -- 결재를 요청한 사람이 있는 건(요청·반려·작성중으로 되돌린 건)은 그 사람만 고치거나 지운다.
  -- 요청 전 작성중 건은 만든 사람 기록이 없어 직원 누구나 고칠 수 있다(승인은 어차피 관리자·재무).
  IF OLD.requested_by IS NOT NULL AND OLD.requested_by IS DISTINCT FROM public.current_employee_id() THEN
    RAISE EXCEPTION '다른 직원이 결재 요청한 매입은 요청한 사람이나 관리자·재무 담당만 고치거나 지울 수 있습니다.' USING ERRCODE = '42501';
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

-- ─────────────────────────────────────────── 4. 거래처 계좌는 관리자·재무만

-- 새 거래처를 등록할 때 계좌를 함께 넣는 건 허용한다(지급은 어차피 관리자·재무 승인을 거친다).
-- 이미 있는 거래처의 계좌를 바꾸는 것(돈이 다른 곳으로 가게 하는 것)만 관리자·재무로 제한한다.
CREATE OR REPLACE FUNCTION public.guard_customer_bank_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' OR public.is_finance_or_admin() THEN
    RETURN NEW;
  END IF;
  IF NEW.bank_name IS DISTINCT FROM OLD.bank_name
     OR NEW.account_number IS DISTINCT FROM OLD.account_number
     OR NEW.account_holder IS DISTINCT FROM OLD.account_holder THEN
    RAISE EXCEPTION '거래처 계좌(은행·계좌번호·예금주)는 관리자 또는 재무 담당만 바꿀 수 있습니다.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_customer_bank_account() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_customers_guard_bank_account ON public.customers;
CREATE TRIGGER trg_customers_guard_bank_account
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_bank_account();

-- ─────────────────────────────────────────── 5. API 키 만료일 필수

UPDATE public.api_keys
SET expires_at = GREATEST(created_at + interval '90 days', now() + interval '30 days')
WHERE expires_at IS NULL;

ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_expires_required;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_expires_required CHECK (expires_at IS NOT NULL);

-- ─────────────────────────────────────────── 6. 입금 자동 연결 트리거 오류 수정

-- uuid 에는 min() 집계가 없어(function min(uuid) does not exist) 연결 안 된 입금을 넣을 때마다 실패하던 문제.
-- 규칙은 그대로다: 입금자명과 금액이 정확히 맞는 미입금 매출이 하나뿐일 때만 자동 연결하고 입금완료로 바꾼다.
CREATE OR REPLACE FUNCTION public.sync_revenue_paid_from_deposit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  matched_revenue_id uuid;
begin
  if new.revenue_id is null then
    select case when count(*) = 1 then (array_agg(candidate.id))[1] else null end
      into matched_revenue_id
      from (
        select r.id
          from public.revenues r
          left join public.projects p
            on p.id = r.project_id
          left join public.customers c
            on c.id = p.customer_id
         where r.is_paid = false
           and r.total_amount = new.amount
           and (
             public.normalize_business_name(new.depositor_name) <> ''
             and public.normalize_business_name(new.depositor_name) in (
               public.normalize_business_name(c.name),
               public.normalize_business_name(c.account_holder),
               public.normalize_business_name(p.client),
               public.normalize_business_name(p.name),
               public.normalize_business_name(r.title)
             )
           )
      ) candidate;

    if matched_revenue_id is not null then
      new.revenue_id := matched_revenue_id;
    end if;
  end if;

  if new.revenue_id is not null
     and (
       tg_op = 'INSERT'
       or old.revenue_id is distinct from new.revenue_id
       or old.deposit_date is distinct from new.deposit_date
     ) then
    update public.revenues
       set is_paid = true,
           paid_date = new.deposit_date
     where id = new.revenue_id;
  end if;

  return new;
end;
$$;
