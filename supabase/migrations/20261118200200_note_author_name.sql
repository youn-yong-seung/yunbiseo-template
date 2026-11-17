-- 2차 재검토 반영 (2026-11-18) — 메모 작성자 이름
-- author_name 은 화면에 그대로 보이는 글자라, 작성자 id 에 맞는 지금 직원 이름으로 서버가 채운다
-- (본인 메모에 다른 사람 이름을 써 넣던 문제).

CREATE OR REPLACE FUNCTION public.set_note_author_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  employee_name text;
BEGIN
  IF NEW.author_employee_id IS NOT NULL THEN
    SELECT e.name INTO employee_name FROM public.employees e WHERE e.id = NEW.author_employee_id;
    IF employee_name IS NOT NULL THEN
      NEW.author_name := employee_name;
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.author_name := OLD.author_name;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.set_note_author_name() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notes', 'project_notes', 'customer_notes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_note_author_name ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_set_note_author_name BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_note_author_name()', t);
  END LOOP;
END $$;
