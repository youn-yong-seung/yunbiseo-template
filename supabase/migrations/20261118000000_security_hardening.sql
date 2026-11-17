-- 보안 정비 (2026-11-18)
--
-- 고친 것
--   1. 일부 테이블(employees·customers·google_oauth_tokens·deposits·expenses 등)은 RLS 가 꺼져 있어
--      브라우저에 노출되는 anon 키만으로 Supabase REST 에서 읽고 쓸 수 있었다. 모든 테이블에 RLS 를 켠다.
--   2. 정책이 "로그인만 하면 전부"였다. Supabase 회원가입이 열려 있으면 아무나 가입해 회사 데이터에 접근할 수 있었다.
--      이제 "활성 직원(employees.auth_uid = 로그인 사용자, is_active = true)"만 회사 데이터에 접근한다.
--   3. API 키·구글 토큰·시스템 설정(외부 서비스 키)·CLI 로그인 코드·로그는 브라우저에서 직접 못 읽는다(서버만).
--   4. 직원 등록·수정·삭제(역할 포함)는 관리자만 한다. 일반 직원이 자기 역할을 관리자로 바꿀 수 없다.
--   5. 할 일·일정·메모는 모두 볼 수 있지만, 고치고 지우는 것은 만든 사람·담당자·관리자만 한다.
--   6. 매입 승인·반려는 관리자 또는 재무 담당만 한다.
--   7. API 키를 직원 id 로 묶는다(이름이 바뀌거나 같은 이름이 있어도 주인이 섞이지 않게).
--   8. yb login 코드에 PKCE(code_challenge)를 붙일 수 있게 하고, 코드를 직원 id 로 묶는다.
--   9. anon 역할의 테이블·함수 권한을 거둔다(RLS 와 별개로 한 번 더 막는다).

-- ─────────────────────────────────────────── 1. 권한 판정 함수
-- RLS 정책 안에서 employees 를 다시 조회하면 정책이 재귀하므로 SECURITY DEFINER 로 만든다.

CREATE OR REPLACE FUNCTION public.current_employee_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id
  FROM public.employees e
  WHERE e.auth_uid = auth.uid()
    AND e.is_active = true
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.is_active_employee()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.auth_uid = auth.uid() AND e.is_active = true
  )
$$;

CREATE OR REPLACE FUNCTION public.is_admin_employee()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.auth_uid = auth.uid() AND e.is_active = true AND e.employee_type = '관리자'
  )
$$;

CREATE OR REPLACE FUNCTION public.is_finance_or_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.employees e
    WHERE e.auth_uid = auth.uid() AND e.is_active = true
      AND (e.employee_type = '관리자' OR e.is_finance = true)
  )
$$;

-- 할 일: 관리자, 만든 사람, 담당자(assigned_to 또는 task_assignees), 만든 사람 기록이 없는 옛 할 일
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
        t.created_by IS NULL
        OR t.created_by = public.current_employee_id()
        OR t.assigned_to = public.current_employee_id()
        OR EXISTS (
          SELECT 1 FROM public.task_assignees ta
          WHERE ta.task_id = t.id AND ta.employee_id = public.current_employee_id()
        )
      )
  )
$$;

-- 일정: 관리자, 만든 사람, 참석자(담당자)
CREATE OR REPLACE FUNCTION public.can_edit_schedule(p_schedule_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.is_admin_employee() OR EXISTS (
    SELECT 1 FROM public.schedules s
    WHERE s.id = p_schedule_id
      AND public.current_employee_id() IS NOT NULL
      AND (
        s.created_by = public.current_employee_id()
        OR EXISTS (
          SELECT 1 FROM public.schedule_attendees sa
          WHERE sa.schedule_id = s.id AND sa.employee_id = public.current_employee_id()
        )
      )
  )
$$;

REVOKE ALL ON FUNCTION public.current_employee_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_active_employee() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_admin_employee() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_finance_or_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_edit_task(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_edit_schedule(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_employee_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_active_employee() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin_employee() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_finance_or_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_edit_task(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_edit_schedule(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────── 2. API 키·CLI 로그인 코드를 직원 id 로 묶기

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES public.employees(id) ON DELETE CASCADE;

-- 기존 키: 만든 사람 이름이 직원 한 명과 정확히 맞을 때만 연결한다. 못 찾은 키는 서버가 거부한다.
UPDATE public.api_keys k
SET employee_id = e.id
FROM public.employees e
WHERE k.employee_id IS NULL
  AND e.name = k.created_by
  AND (SELECT count(*) FROM public.employees e2 WHERE e2.name = k.created_by) = 1;

CREATE INDEX IF NOT EXISTS idx_api_keys_employee_id ON public.api_keys (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_key_hash ON public.api_keys (key_hash);

ALTER TABLE public.cli_auth_requests
  ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES public.employees(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS code_challenge text;

-- 소비했거나 만료된 지 하루 넘은 코드는 지운다(재사용 불가 상태라 남겨 둘 이유가 없다).
DELETE FROM public.cli_auth_requests WHERE expires_at < now() - interval '1 day';

-- ─────────────────────────────────────────── 3. 모든 테이블 RLS 켜고 옛 정책 지우기

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;

  FOR r IN SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- ─────────────────────────────────────────── 4. 회사 공용 데이터: 활성 직원은 보고 쓰고 지울 수 있다

DO $$
DECLARE
  t text;
  shared_tables text[] := ARRAY[
    'customers', 'customer_contacts', 'customer_notes', 'leads',
    'projects', 'project_assignees', 'project_notes', 'project_types',
    'meetings', 'quotations', 'quotation_items',
    'revenues', 'deposits', 'expenses', 'expense_types', 'recurring_expenses',
    'corporate_cards', 'card_transactions', 'schedule_categories'
  ];
BEGIN
  FOREACH t IN ARRAY shared_tables LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'CREATE POLICY "employees_select" ON public.%I FOR SELECT TO authenticated USING (public.is_active_employee())', t);
    EXECUTE format(
      'CREATE POLICY "employees_insert" ON public.%I FOR INSERT TO authenticated WITH CHECK (public.is_active_employee())', t);
    EXECUTE format(
      'CREATE POLICY "employees_update" ON public.%I FOR UPDATE TO authenticated USING (public.is_active_employee()) WITH CHECK (public.is_active_employee())', t);
    EXECUTE format(
      'CREATE POLICY "employees_delete" ON public.%I FOR DELETE TO authenticated USING (public.is_active_employee())', t);
  END LOOP;
END $$;

-- 이력은 보기만 하고 쓰기는 서버(트리거·service role)가 한다.
CREATE POLICY "employees_select" ON public.project_status_history
  FOR SELECT TO authenticated USING (public.is_active_employee());
CREATE POLICY "employees_select" ON public.expense_status_history
  FOR SELECT TO authenticated USING (public.is_active_employee());
CREATE POLICY "employees_insert" ON public.expense_status_history
  FOR INSERT TO authenticated WITH CHECK (public.is_active_employee());

-- ─────────────────────────────────────────── 5. 직원: 모두 보고, 관리자만 등록·수정·삭제

CREATE POLICY "employees_select" ON public.employees
  FOR SELECT TO authenticated USING (public.is_active_employee());
CREATE POLICY "admin_insert" ON public.employees
  FOR INSERT TO authenticated WITH CHECK (public.is_admin_employee());
CREATE POLICY "admin_update" ON public.employees
  FOR UPDATE TO authenticated USING (public.is_admin_employee()) WITH CHECK (public.is_admin_employee());
CREATE POLICY "admin_delete" ON public.employees
  FOR DELETE TO authenticated USING (public.is_admin_employee());

-- 직원이 자기 "지금 집중 중인 할 일"만 바꾸는 함수(직원 행 수정 권한은 관리자만 있으므로 이 칸만 따로 연다).
CREATE OR REPLACE FUNCTION public.set_my_focused_task(p_task_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.employees
  SET focused_task_id = p_task_id
  WHERE auth_uid = auth.uid() AND is_active = true
$$;
REVOKE ALL ON FUNCTION public.set_my_focused_task(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_focused_task(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────── 6. 할 일·일정·메모: 보기는 모두, 고치기는 주인·담당자·관리자

CREATE POLICY "employees_select" ON public.tasks
  FOR SELECT TO authenticated USING (public.is_active_employee());
CREATE POLICY "employees_insert" ON public.tasks
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_employee()
    AND (created_by IS NULL OR created_by = public.current_employee_id() OR public.is_admin_employee())
  );
CREATE POLICY "owner_update" ON public.tasks
  FOR UPDATE TO authenticated USING (public.can_edit_task(id)) WITH CHECK (public.is_active_employee());
CREATE POLICY "owner_delete" ON public.tasks
  FOR DELETE TO authenticated USING (public.can_edit_task(id));

CREATE POLICY "employees_select" ON public.task_assignees
  FOR SELECT TO authenticated USING (public.is_active_employee());
CREATE POLICY "owner_insert" ON public.task_assignees
  FOR INSERT TO authenticated WITH CHECK (public.can_edit_task(task_id));
CREATE POLICY "owner_update" ON public.task_assignees
  FOR UPDATE TO authenticated USING (public.can_edit_task(task_id)) WITH CHECK (public.can_edit_task(task_id));
CREATE POLICY "owner_delete" ON public.task_assignees
  FOR DELETE TO authenticated USING (public.can_edit_task(task_id));

CREATE POLICY "employees_select" ON public.schedules
  FOR SELECT TO authenticated USING (public.is_active_employee());
CREATE POLICY "employees_insert" ON public.schedules
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_employee()
    AND (created_by = public.current_employee_id() OR public.is_admin_employee())
  );
CREATE POLICY "owner_update" ON public.schedules
  FOR UPDATE TO authenticated USING (public.can_edit_schedule(id)) WITH CHECK (public.is_active_employee());
CREATE POLICY "owner_delete" ON public.schedules
  FOR DELETE TO authenticated USING (public.can_edit_schedule(id));

CREATE POLICY "employees_select" ON public.schedule_attendees
  FOR SELECT TO authenticated USING (public.is_active_employee());
CREATE POLICY "owner_insert" ON public.schedule_attendees
  FOR INSERT TO authenticated WITH CHECK (public.can_edit_schedule(schedule_id));
CREATE POLICY "owner_update" ON public.schedule_attendees
  FOR UPDATE TO authenticated USING (public.can_edit_schedule(schedule_id)) WITH CHECK (public.can_edit_schedule(schedule_id));
CREATE POLICY "owner_delete" ON public.schedule_attendees
  FOR DELETE TO authenticated USING (public.can_edit_schedule(schedule_id));

CREATE POLICY "employees_select" ON public.notes
  FOR SELECT TO authenticated USING (public.is_active_employee());
CREATE POLICY "author_insert" ON public.notes
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_active_employee()
    AND (author_employee_id IS NULL OR author_employee_id = public.current_employee_id())
  );
CREATE POLICY "author_update" ON public.notes
  FOR UPDATE TO authenticated
  USING (
    public.is_admin_employee()
    OR (public.is_active_employee() AND (author_employee_id IS NULL OR author_employee_id = public.current_employee_id()))
  )
  WITH CHECK (public.is_active_employee());
CREATE POLICY "author_delete" ON public.notes
  FOR DELETE TO authenticated
  USING (
    public.is_admin_employee()
    OR (public.is_active_employee() AND (author_employee_id IS NULL OR author_employee_id = public.current_employee_id()))
  );

-- ─────────────────────────────────────────── 7. 시스템 설정: 견적 AI 지침만 직원이 직접 읽고 쓴다
-- 나머지 키(볼타·Gemini·슬랙 토큰 등)는 서버가 관리자 확인 뒤 service role 로만 다룬다.

CREATE POLICY "employees_select_public_keys" ON public.system_settings
  FOR SELECT TO authenticated
  USING (public.is_active_employee() AND key IN ('quotation_ai_prompt'));
CREATE POLICY "employees_insert_public_keys" ON public.system_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.is_active_employee() AND key IN ('quotation_ai_prompt'));
CREATE POLICY "employees_update_public_keys" ON public.system_settings
  FOR UPDATE TO authenticated
  USING (public.is_active_employee() AND key IN ('quotation_ai_prompt'))
  WITH CHECK (public.is_active_employee() AND key IN ('quotation_ai_prompt'));

-- api_keys, google_oauth_tokens, cli_auth_requests, app_users, app_logs, gemini_usage_logs:
-- 정책 없음 = 브라우저(anon·authenticated)에서 읽기·쓰기 모두 불가. 서버가 service role 로만 다룬다.

-- ─────────────────────────────────────────── 8. 매입 승인·반려는 관리자 또는 재무 담당만

CREATE OR REPLACE FUNCTION public.guard_expense_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 서버(service role)는 API 에서 권한을 확인한 뒤 바꾼다. 브라우저에서 직접 바꾸는 경우만 막는다.
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('approved', 'rejected')
     AND NOT public.is_finance_or_admin() THEN
    RAISE EXCEPTION '매입 승인·반려는 관리자 또는 재무 담당만 할 수 있습니다.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_expense_approval ON public.expenses;
CREATE TRIGGER trg_guard_expense_approval
  BEFORE UPDATE OF status ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_approval();

-- ─────────────────────────────────────────── 9. anon 권한 거두기

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- 로그인한 직원이 화면에서 쓰는 함수만 다시 허용한다(정책 판정 함수는 위에서 허용).
GRANT EXECUTE ON FUNCTION public.generate_quotation_number() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_project_number() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.normalize_business_name(text) TO authenticated, service_role;
-- 트리거 함수는 트리거로만 실행된다. 일정 참석자 일괄 교체 함수는 서버 전용으로 둔다.
REVOKE EXECUTE ON FUNCTION public.replace_schedule_attendees_atomic(uuid[], uuid[], uuid, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.replace_schedule_attendees_atomic(uuid[], uuid[], uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_project_status(uuid, text, text, uuid, text) TO service_role;
