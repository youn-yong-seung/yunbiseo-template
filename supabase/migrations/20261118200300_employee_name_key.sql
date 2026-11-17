-- 2차 재검토 반영 (2026-11-18) — 직원 이름 위장 방지
-- 보이지 않는 글자(제로폭·방향 제어·한글 채움 등)·전각·NFD·여러 칸 공백으로 다른 직원과 똑같아 보이는 이름을 막는다.
-- 비교용 키: NFKC 정규화 → 보이지 않는 글자 제거 → 공백 모두 제거 → 소문자. ('김 철수'와 '김철수'도 같은 이름으로 본다)

DROP INDEX IF EXISTS public.uq_employees_name_key;

CREATE OR REPLACE FUNCTION public.employee_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT lower(regexp_replace(
    regexp_replace(
      normalize(coalesce(p_name, ''), NFKC),
      '[\u0001-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]',
      '', 'g'),
    '\s+', '', 'g'))
$$;

GRANT EXECUTE ON FUNCTION public.employee_name_key(text) TO authenticated, service_role;

-- 이미 겹치는 이름이 있으면(예전 데이터) 고유 인덱스는 만들지 않고 알림만 남긴다. 앱의 이름 검사는 그대로 동작한다.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.employees
    GROUP BY public.employee_name_key(name) HAVING count(*) > 1
  ) THEN
    RAISE NOTICE '같아 보이는 직원 이름이 이미 있어 uq_employees_name_key 를 만들지 않았습니다. 이름을 정리한 뒤 다시 실행하세요.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_name_key ON public.employees (public.employee_name_key(name));
  END IF;
END $$;
