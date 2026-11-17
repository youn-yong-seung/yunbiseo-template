-- 보안 재검토 반영 (2026-11-18) — 메모
-- 프로젝트·고객 메모도 일반 메모(notes)처럼 보기는 모두, 쓰기는 작성자 본인 이름으로만, 고치기·지우기는 작성자·관리자만.

-- ─────────────────────────────────────────── 4. 프로젝트·고객 메모는 작성자 정책

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_notes', 'customer_notes'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "employees_insert" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "employees_update" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "employees_delete" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "author_insert" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "author_update" ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS "author_delete" ON public.%I', t);
    EXECUTE format($f$
      CREATE POLICY "author_insert" ON public.%I FOR INSERT TO authenticated
      WITH CHECK (
        public.is_active_employee()
        AND author_employee_id = public.current_employee_id()
      )$f$, t);
    EXECUTE format($f$
      CREATE POLICY "author_update" ON public.%I FOR UPDATE TO authenticated
      USING (
        public.is_admin_employee()
        OR (public.is_active_employee() AND (author_employee_id IS NULL OR author_employee_id = public.current_employee_id()))
      )
      WITH CHECK (
        public.is_admin_employee()
        OR (public.is_active_employee() AND author_employee_id = public.current_employee_id())
      )$f$, t);
    EXECUTE format($f$
      CREATE POLICY "author_delete" ON public.%I FOR DELETE TO authenticated
      USING (
        public.is_admin_employee()
        OR (public.is_active_employee() AND (author_employee_id IS NULL OR author_employee_id = public.current_employee_id()))
      )$f$, t);
  END LOOP;
END $$;

-- 일반 메모(notes)도 남의 이름으로 쓰지 못하게 같은 기준으로 맞춘다.
DROP POLICY IF EXISTS "author_insert" ON public.notes;
CREATE POLICY "author_insert" ON public.notes FOR INSERT TO authenticated
  WITH CHECK (public.is_active_employee() AND author_employee_id = public.current_employee_id());
DROP POLICY IF EXISTS "author_update" ON public.notes;
CREATE POLICY "author_update" ON public.notes FOR UPDATE TO authenticated
  USING (
    public.is_admin_employee()
    OR (public.is_active_employee() AND (author_employee_id IS NULL OR author_employee_id = public.current_employee_id()))
  )
  WITH CHECK (
    public.is_admin_employee()
    OR (public.is_active_employee() AND author_employee_id = public.current_employee_id())
  );
