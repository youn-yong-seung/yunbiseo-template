-- 2차 재검토 반영 (2026-11-18) — 로그인 시도 제한
--
-- 1. 시도 예약: 비밀번호를 Supabase 에 확인하기 "전에" 한 번의 잠금 행 갱신으로 시도를 센다.
--    10분 안에 5번까지만 확인을 보낸다(동시에 15번 보내도 5번까지만 비밀번호가 확인된다).
--    5번 실패하면 login_locked_until 로 15분 잠그고, 토큰 발급 훅도 이 값을 본다.
-- 2. 로그인 대상은 인증 이메일(auth.users.email)이 정확히 일치하는 직원으로 찾는다
--    (프로필 아이디를 남의 이메일처럼 바꿔 남의 실패 횟수를 피하던 문제).
-- 3. 앱 쪽 속도 제한: 접속 IP 별·아이디 별로 5분에 10번까지(Supabase 의 서버 전체 한도를 한 사람이 다 쓰지 못하게).

ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS login_locked_until timestamptz;

CREATE OR REPLACE FUNCTION public.reserve_login_attempt(p_employee_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  e record;
BEGIN
  SELECT id, failed_login_count, failed_login_window_started_at, login_locked_until
    INTO e
  FROM public.employees
  WHERE id = p_employee_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF e.login_locked_until IS NOT NULL AND e.login_locked_until > now() THEN
    RETURN false;
  END IF;

  -- 창이 지났거나 잠금이 풀렸으면 새로 센다.
  IF e.failed_login_window_started_at IS NULL
     OR e.failed_login_window_started_at <= now() - interval '10 minutes'
     OR (e.login_locked_until IS NOT NULL AND e.login_locked_until <= now()) THEN
    UPDATE public.employees
    SET failed_login_count = 1,
        failed_login_window_started_at = now(),
        last_failed_login_at = now(),
        login_locked_until = NULL
    WHERE id = p_employee_id;
    RETURN true;
  END IF;

  IF coalesce(e.failed_login_count, 0) >= 5 THEN
    UPDATE public.employees
    SET login_locked_until = now() + interval '15 minutes'
    WHERE id = p_employee_id;
    RETURN false;
  END IF;

  UPDATE public.employees
  SET failed_login_count = coalesce(failed_login_count, 0) + 1,
      last_failed_login_at = now()
  WHERE id = p_employee_id;
  RETURN true;
END;
$$;

-- 예약한 시도가 실패로 끝났을 때: 이미 센 횟수가 5 이상이면 잠근다.
CREATE OR REPLACE FUNCTION public.record_login_failure(p_employee_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.employees
  SET login_locked_until = CASE
        WHEN coalesce(failed_login_count, 0) >= 5 THEN now() + interval '15 minutes'
        ELSE login_locked_until
      END,
      last_failed_login_at = now()
  WHERE id = p_employee_id
  RETURNING failed_login_count
$$;

CREATE OR REPLACE FUNCTION public.employee_by_auth_email(p_email text)
RETURNS TABLE (id uuid, login_id text, is_active boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT e.id, e.login_id, e.is_active
  FROM public.employees e
  JOIN auth.users u ON u.id = e.auth_uid
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1
$$;

CREATE TABLE IF NOT EXISTS public.login_attempt_log (
  id bigserial PRIMARY KEY,
  ip text,
  login_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempt_log_ip ON public.login_attempt_log (ip, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempt_log_key ON public.login_attempt_log (login_key, created_at);
ALTER TABLE public.login_attempt_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_attempt_log FROM anon, authenticated;

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

REVOKE ALL ON FUNCTION public.reserve_login_attempt(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_login_failure(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_by_auth_email(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_login_rate(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_login_attempt(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_login_failure(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.employee_by_auth_email(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.check_login_rate(text, text) TO service_role;

-- 토큰 발급 훅: 잠금은 login_locked_until 로 판단한다.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  emp record;
BEGIN
  SELECT e.is_active, e.login_locked_until
    INTO emp
  FROM public.employees e
  WHERE e.auth_uid = (event->>'user_id')::uuid
  LIMIT 1;

  IF NOT FOUND OR emp.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', '윤비서 직원 계정이 아닙니다.'));
  END IF;

  IF event->>'authentication_method' = 'password'
     AND emp.login_locked_until IS NOT NULL
     AND emp.login_locked_until > now() THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 429, 'message', '로그인이 잠시 잠겼습니다. 15분 뒤 다시 시도하세요.'));
  END IF;

  RETURN event;
END;
$$;

REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin, service_role;
