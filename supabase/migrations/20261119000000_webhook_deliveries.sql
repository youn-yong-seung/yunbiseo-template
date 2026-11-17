-- 볼타 웹훅 재전송 방지 (2026-11-19)
-- 서명이 맞는 웹훅의 webhook-id 를 기록해, 같은 id 가 다시 오면 처리하지 않고 200 으로 끝낸다
-- (가로챈 요청을 5분 안에 다시 보내는 재전송 공격, 볼타의 정상 재시도 중복 처리 모두 막는다).
-- 서명 시각은 5분까지만 받으므로 하루 지난 기록은 지운다. 서버(service role)만 쓴다.

CREATE TABLE IF NOT EXISTS public.webhook_deliveries (
  source text NOT NULL,
  webhook_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, webhook_id)
);

ALTER TABLE public.webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_deliveries FROM anon, authenticated;
