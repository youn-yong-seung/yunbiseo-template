-- 3차 보안 재검토 반영 (2026-11-19)
--
-- 1. 로그인 훅: 잠긴·비활성·직원 아닌 계정의 비밀번호 로그인은 "틀린 비밀번호"와 같은 응답(400, Invalid login credentials)
-- 2. check_login_rate 원자화(IP·아이디별 advisory lock)
-- 3. yb 확인 코드 대조를 한 번의 행 잠금 RPC 로(동시 대입 차단, 5번 틀리면 코드 무효화)
-- 4. 작성자 없는 옛 메모는 관리자만 고치거나 지운다
-- 5. 직원 이름 정규화(보이지 않는 글자·서식 문자 제거 + NFKC) 강화, 저장할 때도 정리, anon 실행 권한 회수
-- 6. 회의록 파일·프로젝트 폴더 Drive id 는 관리자·서버만 바꾼다
-- 7. 볼타로 발행(중)인 매출의 발행 칸·금액은 브라우저에서 바꾸지 못한다, 발행 추적 칸은 서버만
-- 8. 만료일 없는 옛 yb login 키에 만료일 부여, 이후 yb-cli 키는 만료일 필수
-- 9. 메모 이미지 버킷(비공개)과 직원 전용 정책, 영수증 버킷(비공개)

-- ─────────────────────────────────────────── 1. 토큰 발급 훅

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  emp record;
  is_password boolean := (event->>'authentication_method') = 'password';
BEGIN
  SELECT e.is_active, e.login_locked_until
    INTO emp
  FROM public.employees e
  WHERE e.auth_uid = (event->>'user_id')::uuid
  LIMIT 1;

  -- 비밀번호 로그인에서 막는 경우(직원 아님·비활성·잠김)는 모두 "틀린 비밀번호"와 같은 상태·문구로 돌려준다.
  -- 비밀번호가 맞았는지를 응답 차이로 알아내지 못하게 한다.
  IF is_password AND (
       NOT FOUND
       OR emp.is_active IS NOT TRUE
       OR (emp.login_locked_until IS NOT NULL AND emp.login_locked_until > now())
     ) THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 400, 'message', 'Invalid login credentials'));
  END IF;

  -- 토큰 갱신 등: 직원이 아니거나 비활성이면 더는 토큰을 주지 않는다.
  IF NOT FOUND OR emp.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', '윤비서 직원 계정이 아닙니다.'));
  END IF;

  RETURN event;
END;
$$;

REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin, service_role;

-- ─────────────────────────────────────────── 2. 로그인·요청 속도 제한 원자화

-- 같은 IP·같은 키의 요청은 트랜잭션 잠금으로 한 줄로 세운다(세고 넣는 사이에 끼어들지 못한다).
-- 잠금 순서는 항상 IP → 키라서 서로 기다리다 멈추지 않는다.
CREATE OR REPLACE FUNCTION public.check_login_rate(p_ip text, p_login_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  ip_count integer;
  key_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(7101, hashtext(coalesce(p_ip, '')));
  PERFORM pg_advisory_xact_lock(7102, hashtext(coalesce(p_login_key, '')));

  DELETE FROM public.login_attempt_log WHERE created_at < now() - interval '30 minutes';
  SELECT count(*) INTO ip_count FROM public.login_attempt_log
    WHERE ip = p_ip AND created_at > now() - interval '5 minutes';
  SELECT count(*) INTO key_count FROM public.login_attempt_log
    WHERE login_key = p_login_key AND created_at > now() - interval '5 minutes';
  IF ip_count >= 10 OR key_count >= 10 THEN
    RETURN false;
  END IF;
  INSERT INTO public.login_attempt_log (ip, login_key) VALUES (p_ip, p_login_key);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.check_login_rate(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_login_rate(text, text) TO service_role;

-- ─────────────────────────────────────────── 3. yb 확인 코드 대조

-- 'ok' | 'mismatch' | 'gone'. 행을 잠그고 대조하므로 동시에 여러 번 보내도 틀린 횟수가 빠짐없이 쌓인다.
-- 5번째로 틀리면 확인 코드 해시를 지워 그 요청은 더 쓸 수 없다.
CREATE OR REPLACE FUNCTION public.cli_auth_check_user_code(p_request_id uuid, p_code_hash text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
BEGIN
  SELECT id, user_code_hash, code_challenge, employee_id, consumed_at, expires_at, failed_attempts
    INTO r
  FROM public.cli_auth_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND
     OR r.user_code_hash IS NULL
     OR r.code_challenge IS NULL
     OR r.employee_id IS NOT NULL
     OR r.consumed_at IS NOT NULL
     OR r.expires_at <= now()
     OR r.failed_attempts >= 5 THEN
    RETURN 'gone';
  END IF;

  IF r.user_code_hash = p_code_hash THEN
    RETURN 'ok';
  END IF;

  UPDATE public.cli_auth_requests
  SET failed_attempts = failed_attempts + 1,
      user_code_hash = CASE WHEN failed_attempts + 1 >= 5 THEN NULL ELSE user_code_hash END
  WHERE id = p_request_id;
  RETURN 'mismatch';
END;
$$;

REVOKE ALL ON FUNCTION public.cli_auth_check_user_code(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cli_auth_check_user_code(uuid, text) TO service_role;

-- ─────────────────────────────────────────── 4. 작성자 없는 옛 메모

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notes', 'project_notes', 'customer_notes'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "author_update" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "author_delete" ON public.%I', t);
    EXECUTE format($f$
      CREATE POLICY "author_update" ON public.%I FOR UPDATE TO authenticated
      USING (
        public.is_admin_employee()
        OR (public.is_active_employee() AND author_employee_id = public.current_employee_id())
      )
      WITH CHECK (
        public.is_admin_employee()
        OR (public.is_active_employee() AND author_employee_id = public.current_employee_id())
      )$f$, t);
    EXECUTE format($f$
      CREATE POLICY "author_delete" ON public.%I FOR DELETE TO authenticated
      USING (
        public.is_admin_employee()
        OR (public.is_active_employee() AND author_employee_id = public.current_employee_id())
      )$f$, t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────── 5. 직원 이름 정규화
-- src/lib/employee-name.ts 와 같은 규칙:
--   보이지 않는 글자 제거 → NFKC → 다시 제거(NFKC 뒤에 생기는 것까지) → 공백 정리.
--   지우는 글자: 제어문자, 서식 문자(Unicode Cf 전체), 결합 자소 결합기(CGJ), 한글 채움 문자,
--   몽골 자형 선택자, 크메르 모음 내재 문자, 변형 선택자(FE00-FE0F, E0100-E01EF), 태그 문자, 점자 빈칸.

CREATE OR REPLACE FUNCTION public.employee_name_strip_invisible(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT regexp_replace(
    coalesce(p_text, ''),
    '[\u0001-\u001F\u007F-\u009F\u00AD\u034F\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0000-\U000E007F\U000E0100-\U000E01EF]',
    '', 'g')
$$;

-- 저장할 이름: 보이지 않는 글자를 지우고 공백을 한 칸으로, 앞뒤 공백 제거.
CREATE OR REPLACE FUNCTION public.employee_name_clean(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT btrim(regexp_replace(
    public.employee_name_strip_invisible(normalize(public.employee_name_strip_invisible(p_name), NFKC)),
    '[\s\u0085\u1680\u2028\u2029]+', ' ', 'g'))
$$;

-- 같은 사람처럼 보이는지 비교하는 키: 정리한 이름에서 공백을 모두 빼고 소문자로.
CREATE OR REPLACE FUNCTION public.employee_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT lower(replace(public.employee_name_clean(p_name), ' ', ''))
$$;

REVOKE ALL ON FUNCTION public.employee_name_strip_invisible(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.employee_name_clean(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.employee_name_key(text) FROM PUBLIC, anon;
-- 직원 추가·수정(브라우저, 관리자)과 고유 인덱스 계산에 필요한 역할만.
GRANT EXECUTE ON FUNCTION public.employee_name_strip_invisible(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.employee_name_clean(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.employee_name_key(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.clean_employee_name_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.name := public.employee_name_clean(NEW.name);
  IF NEW.name = '' THEN
    RAISE EXCEPTION '직원 이름을 입력하세요.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.clean_employee_name_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_employees_clean_name ON public.employees;
CREATE TRIGGER trg_employees_clean_name
  BEFORE INSERT OR UPDATE OF name ON public.employees
  FOR EACH ROW EXECUTE FUNCTION public.clean_employee_name_before_write();

-- 함수 규칙이 바뀌었으니 이름 키 고유 인덱스를 새 규칙으로 다시 만든다(겹치면 알림만).
DROP INDEX IF EXISTS public.uq_employees_name_key;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.employees
    GROUP BY public.employee_name_key(name) HAVING count(*) > 1
  ) THEN
    RAISE NOTICE '같아 보이는 직원 이름이 이미 있어 uq_employees_name_key 를 만들지 않았습니다. 이름을 정리한 뒤 다시 실행하세요.';
  ELSE
    CREATE UNIQUE INDEX uq_employees_name_key ON public.employees (public.employee_name_key(name));
  END IF;
END $$;

-- ─────────────────────────────────────────── 6. Drive id 는 관리자·서버만

CREATE OR REPLACE FUNCTION public.guard_drive_ids()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- 서버(service_role)·DB 관리 작업과 관리자는 통과.
  IF coalesce(auth.role(), '') <> 'authenticated' OR public.is_admin_employee() THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'meetings' THEN
    IF (TG_OP = 'INSERT' AND NEW.drive_file_id IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND NEW.drive_file_id IS DISTINCT FROM OLD.drive_file_id) THEN
      RAISE EXCEPTION '회의록 Drive 파일은 서버만 연결합니다.' USING ERRCODE = '42501';
    END IF;
  ELSIF TG_TABLE_NAME = 'projects' THEN
    -- 새 프로젝트를 만들 때는 서버가 만든 폴더 id 를 함께 넣는다. 그 뒤 바꾸는 건 관리자만.
    IF TG_OP = 'UPDATE' AND NEW.drive_folder_id IS DISTINCT FROM OLD.drive_folder_id THEN
      RAISE EXCEPTION '프로젝트 Drive 폴더 연결은 관리자만 바꿀 수 있습니다.' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_drive_ids() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_meetings_guard_drive_ids ON public.meetings;
CREATE TRIGGER trg_meetings_guard_drive_ids
  BEFORE INSERT OR UPDATE ON public.meetings
  FOR EACH ROW EXECUTE FUNCTION public.guard_drive_ids();

DROP TRIGGER IF EXISTS trg_projects_guard_drive_ids ON public.projects;
CREATE TRIGGER trg_projects_guard_drive_ids
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.guard_drive_ids();

-- ─────────────────────────────────────────── 7. 볼타 발행 매출 보호(브라우저 직접 쓰기)

CREATE OR REPLACE FUNCTION public.guard_revenue_tax_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'authenticated' THEN
    RETURN NEW;
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

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_revenue_tax_invoice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_revenues_guard_tax_invoice ON public.revenues;
CREATE TRIGGER trg_revenues_guard_tax_invoice
  BEFORE INSERT OR UPDATE ON public.revenues
  FOR EACH ROW EXECUTE FUNCTION public.guard_revenue_tax_invoice();

-- ─────────────────────────────────────────── 8. yb login 키 만료일

-- 만료일 없이 발급된 옛 yb login 키: 발급일 + 90일. 이미 지났으면 지금부터 7일 유예(그 사이 yb login 으로 새 키를 받는다).
UPDATE public.api_keys
SET expires_at = GREATEST(created_at + interval '90 days', now() + interval '7 days')
WHERE expires_at IS NULL
  AND name LIKE 'yb-cli %';

ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_cli_key_expires;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_cli_key_expires CHECK (name NOT LIKE 'yb-cli %' OR expires_at IS NOT NULL);

-- ─────────────────────────────────────────── 9. 메모 이미지·영수증 버킷(비공개)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('note-images', 'note-images', false, 10485760, ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  ('project-note-images', 'project-note-images', false, 10485760, ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  ('customer-note-images', 'customer-note-images', false, 10485760, ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  ('receipts', 'receipts', false, 10485760, ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- 메모 이미지: 직원만 올리고 본다. 고치거나 지우는 건 올린 사람과 관리자만. (SVG 는 받지 않는다)
-- 영수증(receipts)은 브라우저 정책을 두지 않는다. 서버가 만든 1회용 업로드 주소와 짧은 서명 주소로만 다룬다.
DROP POLICY IF EXISTS "note_images_employee_select" ON storage.objects;
DROP POLICY IF EXISTS "note_images_employee_insert" ON storage.objects;
DROP POLICY IF EXISTS "note_images_owner_update" ON storage.objects;
DROP POLICY IF EXISTS "note_images_owner_delete" ON storage.objects;

CREATE POLICY "note_images_employee_select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id IN ('note-images', 'project-note-images', 'customer-note-images') AND public.is_active_employee());

CREATE POLICY "note_images_employee_insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('note-images', 'project-note-images', 'customer-note-images') AND public.is_active_employee());

CREATE POLICY "note_images_owner_update" ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id IN ('note-images', 'project-note-images', 'customer-note-images')
    AND public.is_active_employee()
    AND (owner_id = auth.uid()::text OR public.is_admin_employee())
  )
  WITH CHECK (bucket_id IN ('note-images', 'project-note-images', 'customer-note-images') AND public.is_active_employee());

CREATE POLICY "note_images_owner_delete" ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id IN ('note-images', 'project-note-images', 'customer-note-images')
    AND public.is_active_employee()
    AND (owner_id = auth.uid()::text OR public.is_admin_employee())
  );
