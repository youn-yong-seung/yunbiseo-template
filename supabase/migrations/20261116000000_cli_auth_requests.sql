-- yb CLI 브라우저 로그인용 1회용 인증 코드 저장 테이블
-- 플로우: /api/cli-auth/start 가 세션 인증 후 코드 해시를 발급하고,
--        /api/cli-auth/exchange 가 코드를 원자적으로 소비해 개인 API 키를 발급한다.
-- 원문 코드는 저장하지 않고 sha256 해시만 보관한다. 만료 10분.
-- RLS on·정책 없음 = service-role(admin client) 전용.

CREATE TABLE cli_auth_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  employee_name TEXT NOT NULL,
  auth_uid UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX idx_cli_auth_requests_code_hash ON cli_auth_requests(code_hash);

ALTER TABLE cli_auth_requests ENABLE ROW LEVEL SECURITY;
-- 정책을 만들지 않는다: service-role 만 접근 가능(anon/authenticated 전면 차단).
