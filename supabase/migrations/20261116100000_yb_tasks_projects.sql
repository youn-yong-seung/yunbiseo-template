-- yb CLI 로 할 일·프로젝트를 다루기 위한 준비
--   1) 할 일 짧은 번호(task_no)와 지시 원문(instruction): "2001 끝났어" 처럼 번호로 부른다.
--   2) 프로젝트 단계 이력(project_status_history): 단계가 바뀔 때마다 이전→다음·바꾼 사람·사유를 남긴다.
--   3) set_project_status(): API 가 바꾼 사람·사유와 함께 단계를 한 번에 바꾸는 함수.

-- 1) 할 일 번호 ---------------------------------------------------------------
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS task_no integer;
ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS instruction text;

CREATE SEQUENCE IF NOT EXISTS public.tasks_task_no_seq START 2001;

WITH numbered AS (
  SELECT id, 2000 + row_number() OVER (ORDER BY created_at, id) AS no
  FROM public.tasks
  WHERE task_no IS NULL
)
UPDATE public.tasks t SET task_no = numbered.no FROM numbered WHERE t.id = numbered.id;

SELECT setval('public.tasks_task_no_seq', GREATEST((SELECT COALESCE(MAX(task_no), 2000) FROM public.tasks), 2000));

ALTER TABLE public.tasks ALTER COLUMN task_no SET DEFAULT nextval('public.tasks_task_no_seq');
ALTER TABLE public.tasks ALTER COLUMN task_no SET NOT NULL;
ALTER SEQUENCE public.tasks_task_no_seq OWNED BY public.tasks.task_no;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_task_no ON public.tasks (task_no);

-- 2) 프로젝트 단계 이력 --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_by uuid REFERENCES public.employees(id) ON DELETE SET NULL,
  changed_by_name text,
  note text,
  source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_status_history_project
  ON public.project_status_history (project_id, created_at DESC);

ALTER TABLE public.project_status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can view project status history" ON public.project_status_history;
CREATE POLICY "Authenticated users can view project status history"
  ON public.project_status_history FOR SELECT
  USING (auth.role() = 'authenticated');

-- 웹 화면(세션)에서 바꾸면 auth.uid() 로 직원을 찾고, API 는 set_project_status() 가 넘긴 값을 쓴다.
CREATE OR REPLACE FUNCTION public.log_project_status_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_text text := nullif(current_setting('yb.actor_employee_id', true), '');
  v_actor uuid;
  v_name text;
  v_note text := nullif(current_setting('yb.status_note', true), '');
  v_source text := nullif(current_setting('yb.status_source', true), '');
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_actor_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_actor := v_actor_text::uuid;
  ELSE
    BEGIN
      SELECT e.id INTO v_actor FROM public.employees e WHERE e.auth_uid = auth.uid() LIMIT 1;
    EXCEPTION WHEN others THEN
      v_actor := NULL;
    END;
  END IF;

  IF v_actor IS NOT NULL THEN
    SELECT e.name INTO v_name FROM public.employees e WHERE e.id = v_actor;
  END IF;

  INSERT INTO public.project_status_history
    (project_id, from_status, to_status, changed_by, changed_by_name, note, source)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END,
    NEW.status,
    v_actor,
    v_name,
    v_note,
    coalesce(v_source, CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'web' END)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_status_history ON public.projects;
CREATE TRIGGER trg_project_status_history
  AFTER INSERT OR UPDATE OF status ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.log_project_status_change();

-- 3) API 용 단계 변경 함수 -------------------------------------------------------
-- 같은 트랜잭션 안에서 바꾼 사람·사유를 넘긴 뒤 단계를 바꾼다(supabase-js 는 요청마다 트랜잭션이 따로라 함수로 묶는다).
CREATE OR REPLACE FUNCTION public.set_project_status(
  p_project_id uuid,
  p_status text,
  p_note text DEFAULT NULL,
  p_actor_employee_id uuid DEFAULT NULL,
  p_source text DEFAULT 'api'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('yb.actor_employee_id', coalesce(p_actor_employee_id::text, ''), true);
  PERFORM set_config('yb.status_note', coalesce(p_note, ''), true);
  PERFORM set_config('yb.status_source', coalesce(p_source, 'api'), true);
  UPDATE public.projects SET status = p_status WHERE id = p_project_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_project_status(uuid, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_project_status(uuid, text, text, uuid, text) TO service_role;
