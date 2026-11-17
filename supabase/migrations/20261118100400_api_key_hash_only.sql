-- 보안 재검토 반영 (2026-11-18) — API 키
-- 키 원문을 되살릴 수 있게 저장하던 key_encrypted 를 없앤다. DB 에는 sha256 해시와 앞 12자만 남는다.
-- 원문은 발급할 때 한 번만 보여 준다. 기존 키는 해시로 계속 동작하고, "다시 보기"만 없어진다.

-- ─────────────────────────────────────────── 7. API 키 원문 저장 제거

ALTER TABLE public.api_keys DROP COLUMN IF EXISTS key_encrypted;
