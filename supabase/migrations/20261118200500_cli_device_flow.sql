-- 2차 재검토 반영 (2026-11-18) — yb login 확인 코드(디바이스 플로우)와 CLI 키 만료
--
-- 1. yb 가 먼저 요청을 등록하고(확인 코드를 받아 터미널에 보여 줌), 웹 승인 화면에서 같은 확인 코드를 입력해야 승인된다.
--    남이 만든 인증 주소를 받아 버튼만 눌러 주는 "동의 피싱"을 막는다. 확인 코드는 해시만 저장한다.
-- 2. yb login 으로 받은 키에는 만료일(90일)을 둔다. 만료된 키는 거부한다(웹에서 만든 키는 만료 없음).

ALTER TABLE public.cli_auth_requests ALTER COLUMN code_hash DROP NOT NULL;
ALTER TABLE public.cli_auth_requests ALTER COLUMN employee_name DROP NOT NULL;
ALTER TABLE public.cli_auth_requests
  ADD COLUMN IF NOT EXISTS user_code_hash text,
  ADD COLUMN IF NOT EXISTS hostname text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;
