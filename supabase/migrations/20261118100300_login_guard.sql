-- 보안 재검토 반영 (2026-11-18) — 로그인
-- 로그인 실패 횟수를 UPDATE 한 번으로 올린다(동시 요청에도 빠짐없이 센다).
-- Supabase Auth 토큰 발급 훅: 직원이 아니거나 비활성이면 토큰을 주지 않고, 잠긴 계정은 비밀번호 로그인을 막는다.
-- (Supabase 대시보드 → Authentication → Hooks 에서 이 함수를 켜야 동작한다. SETUP.md 3-2 참고)

-- ─────────────────────────────────────────── 5. 로그인 실패 횟수 원자적 증가

CREATE OR REPLACE FUNCTION public.record_login_failure(p_employee_id uuid)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.employees
  SET
    failed_login_count = CASE
      WHEN failed_login_window_started_at IS NOT NULL
           AND failed_login_window_started_at > now() - interval '10 minutes'
        THEN failed_login_count + 1
      ELSE 1
    END,
    failed_login_window_started_at = CASE
      WHEN failed_login_window_started_at IS NOT NULL
           AND failed_login_window_started_at > now() - interval '10 minutes'
        THEN failed_login_window_started_at
      ELSE now()
    END,
    last_failed_login_at = now()
  WHERE id = p_employee_id
  RETURNING failed_login_count
$$;

REVOKE ALL ON FUNCTION public.record_login_failure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_login_failure(uuid) TO service_role;

-- ─────────────────────────────────────────── 6. 토큰 발급 훅 (Custom Access Token Hook)

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
  SELECT e.is_active, e.failed_login_count, e.last_failed_login_at
    INTO emp
  FROM public.employees e
  WHERE e.auth_uid = (event->>'user_id')::uuid
  LIMIT 1;

  -- 직원으로 등록되지 않았거나 비활성인 계정에는 토큰을 주지 않는다(회원가입으로 만든 계정 포함).
  IF NOT FOUND OR emp.is_active IS NOT TRUE THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403, 'message', '윤비서 직원 계정이 아닙니다.'));
  END IF;

  -- 비밀번호를 5번 틀려 잠긴 동안(15분)은 Supabase 로 직접 비밀번호 로그인하는 것도 막는다.
  -- 이미 로그인한 세션의 토큰 갱신(token_refresh)은 막지 않는다.
  IF event->>'authentication_method' = 'password'
     AND coalesce(emp.failed_login_count, 0) >= 5
     AND emp.last_failed_login_at > now() - interval '15 minutes' THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 429, 'message', '로그인이 잠시 잠겼습니다. 15분 뒤 다시 시도하세요.'));
  END IF;

  RETURN event;
END;
$$;

REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin, service_role;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
