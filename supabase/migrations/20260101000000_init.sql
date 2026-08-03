-- 윤비서 템플릿 초기 스키마 (원본 라이브 DB public 스키마 전체 덤프)
-- 빈 Supabase 프로젝트에 supabase db push 로 한 번에 적용됩니다.
-- 정리: pg_dump 산출물에서 psql 메타명령과 Supabase 내부 권한구문(스키마 GRANT/COMMENT,
--       DEFAULT PRIVILEGES)을 제거해 빈 프로젝트에서 바로 적용되게 함

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



--
-- Name: generate_project_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_project_number() RETURNS text
    LANGUAGE plpgsql
    AS $_$
    DECLARE
      yy TEXT;
      seq INT;
    BEGIN
      yy := TO_CHAR(NOW(), 'YY');
      SELECT COALESCE(MAX(
        CAST(SPLIT_PART(project_number, '-', 2) AS INT)
      ), 0) + 1
      INTO seq
      FROM projects
      WHERE project_number LIKE yy || '-%'
        AND SPLIT_PART(project_number, '-', 2) ~ '^[0-9]+$';
      RETURN yy || '-' || seq::TEXT;
    END;
    $_$;


--
-- Name: generate_quotation_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_quotation_number() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  yymm TEXT;
  letters TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ';  -- I, O 제외 (1, 0과 혼동)
  digits TEXT := '123456789';                    -- 0 제외
  letter CHAR(1);
  digit CHAR(1);
  candidate TEXT;
  attempts INT := 0;
BEGIN
  yymm := TO_CHAR(NOW(), 'YYMM');

  LOOP
    letter := SUBSTR(letters, FLOOR(RANDOM() * LENGTH(letters) + 1)::INT, 1);
    digit := SUBSTR(digits, FLOOR(RANDOM() * LENGTH(digits) + 1)::INT, 1);
    candidate := 'Q' || yymm || '-' || letter || digit;

    -- 중복 확인
    IF NOT EXISTS (SELECT 1 FROM quotations WHERE quotation_number = candidate) THEN
      RETURN candidate;
    END IF;

    attempts := attempts + 1;
    IF attempts > 100 THEN
      RAISE EXCEPTION 'Failed to generate unique quotation number after 100 attempts';
    END IF;
  END LOOP;
END;
$$;


--
-- Name: normalize_business_name(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_business_name(value text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select lower(
    regexp_replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  replace(
                    replace(
                      replace(
                        replace(
                          replace(
                            replace(
                              replace(
                                regexp_replace(coalesce(value, ''), '[㈜㈔]', '', 'g'),
                                '(주)',
                                ''
                              ),
                              '(유)',
                              ''
                            ),
                            '(재)',
                            ''
                          ),
                          '(사)',
                          ''
                        ),
                        '주식회사',
                        ''
                      ),
                      '유한회사',
                      ''
                    ),
                    '재단법인',
                    ''
                  ),
                  '사단법인',
                  ''
                ),
                '유한책임회사',
                ''
              ),
              ' ',
              ''
            ),
            '-',
            ''
          ),
          '_',
          ''
        ),
        '.',
        ''
      ),
      '[·・()[\]{}''"&]',
      '',
      'g'
    )
  );
$$;


--
-- Name: replace_schedule_attendees_atomic(uuid[], uuid[], uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  accessible_count integer;
  requested_count integer;
begin
  requested_count := coalesce(array_length(p_schedule_ids, 1), 0);

  if requested_count = 0 then
    return;
  end if;

  if not p_is_admin then
    select count(distinct s.id)
      into accessible_count
    from schedules s
    left join schedule_attendees sa
      on sa.schedule_id = s.id
    where s.id = any(p_schedule_ids)
      and (s.created_by = p_actor_employee_id or sa.employee_id = p_actor_employee_id);

    if accessible_count <> requested_count then
      raise exception 'schedule access denied';
    end if;
  end if;

  delete from schedule_attendees
  where schedule_id = any(p_schedule_ids);

  if coalesce(array_length(p_attendee_ids, 1), 0) = 0 then
    return;
  end if;

  insert into schedule_attendees (schedule_id, employee_id)
  select schedule_id, employee_id
  from unnest(p_schedule_ids) as schedule_id
  cross join unnest(p_attendee_ids) as employee_id;
end;
$$;


--
-- Name: reset_schedule_slack_reminder_sent_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_schedule_slack_reminder_sent_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.start_at IS DISTINCT FROM OLD.start_at OR
    NEW.end_at IS DISTINCT FROM OLD.end_at OR
    NEW.all_day IS DISTINCT FROM OLD.all_day
  ) THEN
    NEW.slack_reminder_sent_at = NULL;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: sync_revenue_paid_from_deposit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_revenue_paid_from_deposit() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  matched_revenue_id uuid;
begin
  if new.revenue_id is null then
    select case when count(*) = 1 then min(candidate.id) else null end
      into matched_revenue_id
      from (
        select r.id
          from public.revenues r
          left join public.projects p
            on p.id = r.project_id
          left join public.customers c
            on c.id = p.customer_id
         where r.is_paid = false
           and r.total_amount = new.amount
           and (
             public.normalize_business_name(new.depositor_name) <> ''
             and public.normalize_business_name(new.depositor_name) in (
               public.normalize_business_name(c.name),
               public.normalize_business_name(c.account_holder),
               public.normalize_business_name(p.client),
               public.normalize_business_name(p.name),
               public.normalize_business_name(r.title)
             )
           )
      ) candidate;

    if matched_revenue_id is not null then
      new.revenue_id := matched_revenue_id;
    end if;
  end if;

  if new.revenue_id is not null
     and (
       tg_op = 'INSERT'
       or old.revenue_id is distinct from new.revenue_id
       or old.deposit_date is distinct from new.deposit_date
     ) then
    update public.revenues
       set is_paid = true,
           paid_date = new.deposit_date
     where id = new.revenue_id;
  end if;

  return new;
end;
$$;


--
-- Name: update_google_oauth_tokens_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_google_oauth_tokens_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    key_hash text NOT NULL,
    key_prefix text NOT NULL,
    created_by text NOT NULL,
    last_used_at timestamp with time zone,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    key_encrypted text
);


--
-- Name: app_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    level text DEFAULT 'INFO'::text NOT NULL,
    action text NOT NULL,
    resource text,
    resource_id text,
    message text NOT NULL,
    actor_id text,
    actor_name text,
    ip_address text,
    details jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT app_logs_level_check CHECK ((level = ANY (ARRAY['INFO'::text, 'ERROR'::text])))
);


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id bigint NOT NULL,
    user_id uuid,
    role text DEFAULT 'user'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT app_users_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'user'::text])))
);


--
-- Name: app_users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.app_users_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: app_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.app_users_id_seq OWNED BY public.app_users.id;


--
-- Name: customer_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    name text NOT NULL,
    "position" text,
    phone text,
    email text,
    memo text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: customer_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    title text,
    content text,
    link_url text,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_notes_check CHECK ((COALESCE(NULLIF(btrim(title), ''::text), NULLIF(btrim(content), ''::text), NULLIF(btrim(link_url), ''::text)) IS NOT NULL))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_type text,
    name text NOT NULL,
    business_number text,
    contact_name text,
    contact_email text,
    contact_phone text,
    address text,
    memo text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    representative_name text,
    tax_category text,
    default_withholding_rate numeric(5,4),
    bank_name text,
    account_number text,
    account_holder text,
    is_vendor boolean GENERATED ALWAYS AS ((tax_category IS NOT NULL)) STORED,
    resident_number text,
    drive_folder_id text,
    CONSTRAINT customers_customer_type_check CHECK (((customer_type IS NULL) OR (customer_type = ANY (ARRAY['개인'::text, '개인사업자'::text, '법인'::text])))),
    CONSTRAINT customers_tax_category_check CHECK ((tax_category = ANY (ARRAY['personal_withholding'::text, 'business_vat'::text, 'corporate_vat'::text, 'none'::text])))
);


--
-- Name: deposits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deposits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deposit_date date NOT NULL,
    amount integer NOT NULL,
    depositor_name text NOT NULL,
    bank_name text,
    account_alias text,
    revenue_id uuid,
    source text DEFAULT 'manual'::text NOT NULL,
    raw_message text,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deposits_amount_check CHECK ((amount > 0)),
    CONSTRAINT deposits_source_check CHECK ((source = ANY (ARRAY['webhook'::text, 'manual'::text])))
);


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    department text,
    "position" text,
    email text,
    phone text,
    hire_date date,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    login_id text,
    auth_uid uuid,
    employee_type text DEFAULT '직원'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    failed_login_count integer DEFAULT 0 NOT NULL,
    failed_login_window_started_at timestamp with time zone,
    last_failed_login_at timestamp with time zone,
    last_login_at timestamp with time zone,
    slack_id text,
    focused_task_id uuid,
    is_finance boolean DEFAULT false NOT NULL,
    CONSTRAINT employees_employee_type_check CHECK ((employee_type = ANY (ARRAY['관리자'::text, '직원'::text])))
);


--
-- Name: expense_status_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_status_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    expense_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    actor_id uuid,
    actor_name text,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: expense_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expense_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_code text,
    is_vat_deductible boolean DEFAULT true NOT NULL
);


--
-- Name: expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    revenue_id uuid,
    project_id uuid,
    type_id uuid,
    title text NOT NULL,
    vendor_name text,
    total_amount integer NOT NULL,
    supply_amount integer NOT NULL,
    vat_amount integer DEFAULT 0 NOT NULL,
    vat_included boolean DEFAULT true NOT NULL,
    purchase_date date,
    payment_date date,
    purchase_tax_invoice_received boolean DEFAULT false NOT NULL,
    purchase_tax_invoice_date date,
    purchase_tax_invoice_not_required boolean DEFAULT false NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    vendor_id uuid,
    tax_category text,
    withholding_rate numeric(5,4),
    withholding_amount integer DEFAULT 0 NOT NULL,
    net_payment_amount integer GENERATED ALWAYS AS ((total_amount - COALESCE(withholding_amount, 0))) STORED,
    requested_by uuid,
    requested_at timestamp with time zone,
    approver_id uuid,
    approved_at timestamp with time zone,
    rejected_reason text,
    cancelled_at timestamp with time zone,
    cancelled_reason text,
    slack_thread_ts text,
    source text DEFAULT 'manual'::text NOT NULL,
    recurring_expense_id uuid,
    receipt_url text,
    CONSTRAINT expenses_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'recurring'::text]))),
    CONSTRAINT expenses_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'requested'::text, 'approved'::text, 'rejected'::text, 'scheduled'::text, 'paid'::text, 'cancelled'::text]))),
    CONSTRAINT expenses_tax_category_check CHECK ((tax_category = ANY (ARRAY['personal_withholding'::text, 'business_vat'::text, 'corporate_vat'::text, 'none'::text])))
);


--
-- Name: gemini_usage_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gemini_usage_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_auth_uid uuid NOT NULL,
    feature text NOT NULL,
    model text NOT NULL,
    input_tokens integer DEFAULT 0 NOT NULL,
    output_tokens integer DEFAULT 0 NOT NULL,
    input_cost numeric(10,6) DEFAULT 0 NOT NULL,
    output_cost numeric(10,6) DEFAULT 0 NOT NULL,
    total_cost numeric(10,6) DEFAULT 0 NOT NULL,
    image_count integer DEFAULT 1 NOT NULL,
    request_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: google_oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.google_oauth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    gmail_email text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    token_expiry timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_global boolean DEFAULT false NOT NULL
);


--
-- Name: leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_name text NOT NULL,
    contact_name text NOT NULL,
    phone text NOT NULL,
    email text,
    "position" text,
    referral_source text,
    industry text,
    automation_areas text[],
    budget text,
    desired_timeline text,
    inquiry_detail text,
    status text DEFAULT '신규'::text NOT NULL,
    source text DEFAULT '폼문의'::text NOT NULL,
    assigned_to uuid,
    customer_id uuid,
    memo text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    lead_type text DEFAULT '개발'::text NOT NULL,
    edu_schedule text,
    edu_filming_schedule text,
    edu_delivery_mode text,
    edu_hourly_rate integer,
    edu_estimated_hours numeric(6,1),
    edu_estimated_total integer,
    CONSTRAINT leads_edu_delivery_mode_check CHECK ((edu_delivery_mode = ANY (ARRAY['온라인'::text, '오프라인'::text, '혼합'::text]))),
    CONSTRAINT leads_lead_type_check CHECK ((lead_type = ANY (ARRAY['개발'::text, '교육'::text]))),
    CONSTRAINT leads_source_check CHECK ((source = ANY (ARRAY['폼문의'::text, '전화'::text, '이메일'::text, '소개'::text, '기타'::text]))),
    CONSTRAINT leads_status_check CHECK ((status = ANY (ARRAY['신규'::text, '상담중'::text, '견적발송'::text, '계약완료'::text, '실패'::text, '보류'::text])))
);


--
-- Name: meetings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meetings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    project_id uuid,
    transcript text DEFAULT ''::text,
    status text DEFAULT '진행중'::text,
    started_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    summary text DEFAULT ''::text NOT NULL,
    customer_id uuid,
    lead_id uuid,
    drive_file_id text
);


--
-- Name: notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text,
    content text,
    link_url text,
    project_id uuid,
    customer_id uuid,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: project_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    title text,
    content text,
    link_url text,
    author_employee_id uuid,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_notes_check CHECK ((COALESCE(NULLIF(btrim(title), ''::text), NULLIF(btrim(content), ''::text), NULLIF(btrim(link_url), ''::text)) IS NOT NULL))
);


--
-- Name: project_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    drive_folder_id text
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_number text NOT NULL,
    name text NOT NULL,
    client text,
    description text,
    status text DEFAULT '진행예정'::text,
    start_date date,
    end_date date,
    manager text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    drive_folder_id text,
    customer_id uuid,
    type_id uuid
);


--
-- Name: quotation_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotation_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_id uuid NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    item_name text NOT NULL,
    specification text DEFAULT ''::text,
    unit text DEFAULT '식'::text NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    unit_price bigint DEFAULT 0 NOT NULL,
    supply_amount bigint DEFAULT 0 NOT NULL,
    remark text DEFAULT ''::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: quotations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quotations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    quotation_number text NOT NULL,
    quotation_date date DEFAULT CURRENT_DATE NOT NULL,
    valid_until date,
    status text DEFAULT '작성중'::text NOT NULL,
    customer_id uuid,
    recipient_name text NOT NULL,
    recipient_contact_name text,
    recipient_phone text,
    recipient_address text,
    supplier_name text DEFAULT ''::text NOT NULL,
    supplier_representative text DEFAULT ''::text NOT NULL,
    supplier_business_number text DEFAULT ''::text NOT NULL,
    supplier_phone text DEFAULT ''::text NOT NULL,
    supplier_manager text DEFAULT ''::text NOT NULL,
    supplier_address text DEFAULT ''::text,
    supplier_business_type text DEFAULT ''::text,
    supplier_business_category text DEFAULT ''::text,
    supply_total bigint DEFAULT 0 NOT NULL,
    vat_total bigint DEFAULT 0 NOT NULL,
    grand_total bigint DEFAULT 0 NOT NULL,
    payment_terms text,
    delivery_terms text,
    bank_account text DEFAULT ''::text NOT NULL,
    memo text,
    project_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    parent_id uuid,
    CONSTRAINT quotations_status_check CHECK ((status = ANY (ARRAY['작성중'::text, '발송완료'::text, '수락'::text, '거절'::text, '만료'::text])))
);


--
-- Name: recurring_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    type_id uuid,
    vendor_name text,
    vendor_id uuid,
    amount integer NOT NULL,
    vat_included boolean DEFAULT true NOT NULL,
    day_of_month smallint NOT NULL,
    start_date date NOT NULL,
    end_date date,
    last_generated_month text,
    is_active boolean DEFAULT true NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recurring_expenses_day_of_month_check CHECK (((day_of_month >= 1) AND (day_of_month <= 28)))
);


--
-- Name: revenues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.revenues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid,
    title text NOT NULL,
    total_amount bigint DEFAULT 0 NOT NULL,
    supply_amount bigint DEFAULT 0 NOT NULL,
    vat_amount bigint DEFAULT 0 NOT NULL,
    revenue_date date,
    is_paid boolean DEFAULT false,
    paid_date date,
    is_tax_invoice_issued boolean DEFAULT false,
    tax_invoice_date date,
    memo text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tax_invoice_not_required boolean DEFAULT false NOT NULL,
    vat_included boolean DEFAULT true NOT NULL,
    channel text,
    product_name text,
    external_order_id text,
    expected_payment_date date,
    tax_invoice_issue_status text DEFAULT 'not_issued'::text NOT NULL,
    tax_invoice_issuance_key text,
    tax_invoice_client_reference_id text,
    tax_invoice_issue_requested_at timestamp with time zone,
    tax_invoice_issued_at timestamp with time zone,
    tax_invoice_last_webhook_at timestamp with time zone,
    tax_invoice_url text,
    tax_invoice_nts_transaction_id text,
    tax_invoice_error_code text,
    tax_invoice_error_message text,
    tax_invoice_request_payload jsonb,
    tax_invoice_last_payload jsonb,
    type_id uuid,
    CONSTRAINT revenues_tax_invoice_issue_status_check CHECK ((tax_invoice_issue_status = ANY (ARRAY['not_issued'::text, 'issuing'::text, 'issued'::text, 'failed'::text])))
);


--
-- Name: schedule_attendees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_attendees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: schedule_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    value text NOT NULL,
    label text NOT NULL,
    color text DEFAULT '#6b7280'::text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    all_day boolean DEFAULT false,
    location text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    category text DEFAULT 'other'::text NOT NULL,
    project_id uuid,
    slack_reminder_sent_at timestamp with time zone,
    recurrence_type text DEFAULT 'none'::text NOT NULL,
    recurrence_end_date date,
    recurrence_group_id uuid,
    google_calendar_id text,
    google_event_id text,
    google_event_status text DEFAULT 'none'::text NOT NULL,
    google_etag text,
    google_updated_at timestamp with time zone,
    sync_source text DEFAULT 'local'::text NOT NULL,
    google_meet_link text,
    customer_id uuid,
    lead_id uuid,
    CONSTRAINT schedules_recurrence_type_check CHECK ((recurrence_type = ANY (ARRAY['none'::text, 'daily'::text, 'weekly'::text, 'monthly'::text])))
);


--
-- Name: COLUMN schedules.recurrence_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schedules.recurrence_type IS '반복 유형: none(없음), daily(매일), weekly(매주), monthly(매월)';


--
-- Name: COLUMN schedules.recurrence_end_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schedules.recurrence_end_date IS '반복 종료 날짜';


--
-- Name: COLUMN schedules.recurrence_group_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.schedules.recurrence_group_id IS '같은 반복 규칙에서 생성된 일정끼리 묶는 그룹 ID';


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: task_assignees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT '할 일'::text NOT NULL,
    priority text DEFAULT '보통'::text NOT NULL,
    assigned_to uuid,
    due_date date,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    sort_order integer DEFAULT 0 NOT NULL,
    project_id uuid,
    start_date date,
    estimated_minutes integer,
    actual_minutes integer,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    slack_thread_ts text,
    CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['높음'::text, '보통'::text, '낮음'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['백로그'::text, '할 일'::text, '진행중'::text, '완료'::text, '취소'::text])))
);


--
-- Name: app_users id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users ALTER COLUMN id SET DEFAULT nextval('public.app_users_id_seq'::regclass);


--
-- Name: api_keys api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: app_logs app_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_logs
    ADD CONSTRAINT app_logs_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_user_id_key UNIQUE (user_id);


--
-- Name: customer_contacts customer_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_contacts
    ADD CONSTRAINT customer_contacts_pkey PRIMARY KEY (id);


--
-- Name: customer_notes customer_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_notes
    ADD CONSTRAINT customer_notes_pkey PRIMARY KEY (id);


--
-- Name: customers customers_business_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_business_number_key UNIQUE (business_number);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: deposits deposits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_pkey PRIMARY KEY (id);


--
-- Name: employees employees_login_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_login_id_key UNIQUE (login_id);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: expense_status_history expense_status_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_status_history
    ADD CONSTRAINT expense_status_history_pkey PRIMARY KEY (id);


--
-- Name: expense_types expense_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_types
    ADD CONSTRAINT expense_types_name_key UNIQUE (name);


--
-- Name: expense_types expense_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_types
    ADD CONSTRAINT expense_types_pkey PRIMARY KEY (id);


--
-- Name: expenses expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_pkey PRIMARY KEY (id);


--
-- Name: gemini_usage_logs gemini_usage_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gemini_usage_logs
    ADD CONSTRAINT gemini_usage_logs_pkey PRIMARY KEY (id);


--
-- Name: google_oauth_tokens google_oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: google_oauth_tokens google_oauth_tokens_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_user_id_key UNIQUE (user_id);


--
-- Name: leads leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);


--
-- Name: meetings meetings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_pkey PRIMARY KEY (id);


--
-- Name: notes notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_pkey PRIMARY KEY (id);


--
-- Name: project_assignees project_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_assignees
    ADD CONSTRAINT project_assignees_pkey PRIMARY KEY (id);


--
-- Name: project_assignees project_assignees_project_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_assignees
    ADD CONSTRAINT project_assignees_project_id_employee_id_key UNIQUE (project_id, employee_id);


--
-- Name: project_notes project_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_pkey PRIMARY KEY (id);


--
-- Name: project_types project_types_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_types
    ADD CONSTRAINT project_types_name_key UNIQUE (name);


--
-- Name: project_types project_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_types
    ADD CONSTRAINT project_types_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: projects projects_project_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_project_number_key UNIQUE (project_number);


--
-- Name: quotation_items quotation_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_items
    ADD CONSTRAINT quotation_items_pkey PRIMARY KEY (id);


--
-- Name: quotations quotations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_pkey PRIMARY KEY (id);


--
-- Name: quotations quotations_quotation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_quotation_number_key UNIQUE (quotation_number);


--
-- Name: recurring_expenses recurring_expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_expenses
    ADD CONSTRAINT recurring_expenses_pkey PRIMARY KEY (id);


--
-- Name: revenues revenues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenues
    ADD CONSTRAINT revenues_pkey PRIMARY KEY (id);


--
-- Name: schedule_attendees schedule_attendees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_attendees
    ADD CONSTRAINT schedule_attendees_pkey PRIMARY KEY (id);


--
-- Name: schedule_attendees schedule_attendees_schedule_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_attendees
    ADD CONSTRAINT schedule_attendees_schedule_id_employee_id_key UNIQUE (schedule_id, employee_id);


--
-- Name: schedule_categories schedule_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_categories
    ADD CONSTRAINT schedule_categories_pkey PRIMARY KEY (id);


--
-- Name: schedule_categories schedule_categories_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_categories
    ADD CONSTRAINT schedule_categories_value_key UNIQUE (value);


--
-- Name: schedules schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (key);


--
-- Name: task_assignees task_assignees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_pkey PRIMARY KEY (id);


--
-- Name: task_assignees task_assignees_task_id_employee_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_task_id_employee_id_key UNIQUE (task_id, employee_id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: idx_api_keys_name_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_keys_name_active ON public.api_keys USING btree (name, is_active);


--
-- Name: idx_app_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_logs_created_at ON public.app_logs USING btree (created_at DESC);


--
-- Name: idx_app_logs_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_logs_level ON public.app_logs USING btree (level);


--
-- Name: idx_customer_contacts_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_contacts_customer_id ON public.customer_contacts USING btree (customer_id);


--
-- Name: idx_customer_notes_customer_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customer_notes_customer_id_created_at ON public.customer_notes USING btree (customer_id, created_at DESC);


--
-- Name: idx_customers_is_vendor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_customers_is_vendor ON public.customers USING btree (is_vendor) WHERE (is_vendor = true);


--
-- Name: idx_employees_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_is_active ON public.employees USING btree (is_active);


--
-- Name: idx_employees_login_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_login_id ON public.employees USING btree (login_id);


--
-- Name: idx_expense_status_history_expense_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expense_status_history_expense_id ON public.expense_status_history USING btree (expense_id, created_at DESC);


--
-- Name: idx_expenses_payment_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_payment_date ON public.expenses USING btree (payment_date);


--
-- Name: idx_expenses_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_project_id ON public.expenses USING btree (project_id);


--
-- Name: idx_expenses_purchase_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_purchase_date ON public.expenses USING btree (purchase_date);


--
-- Name: idx_expenses_recurring; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_recurring ON public.expenses USING btree (recurring_expense_id) WHERE (recurring_expense_id IS NOT NULL);


--
-- Name: idx_expenses_revenue_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_revenue_id ON public.expenses USING btree (revenue_id);


--
-- Name: idx_expenses_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_source ON public.expenses USING btree (source);


--
-- Name: idx_expenses_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_status ON public.expenses USING btree (status);


--
-- Name: idx_expenses_type_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_type_id ON public.expenses USING btree (type_id);


--
-- Name: idx_expenses_vendor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expenses_vendor_id ON public.expenses USING btree (vendor_id);


--
-- Name: idx_gemini_usage_logs_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gemini_usage_logs_created ON public.gemini_usage_logs USING btree (created_at DESC);


--
-- Name: idx_gemini_usage_logs_feature; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gemini_usage_logs_feature ON public.gemini_usage_logs USING btree (feature);


--
-- Name: idx_gemini_usage_logs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gemini_usage_logs_user ON public.gemini_usage_logs USING btree (user_auth_uid);


--
-- Name: idx_google_oauth_tokens_one_global; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_google_oauth_tokens_one_global ON public.google_oauth_tokens USING btree (is_global) WHERE (is_global = true);


--
-- Name: idx_leads_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_assigned_to ON public.leads USING btree (assigned_to);


--
-- Name: idx_leads_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_customer_id ON public.leads USING btree (customer_id);


--
-- Name: idx_leads_lead_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_lead_type ON public.leads USING btree (lead_type);


--
-- Name: idx_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_status ON public.leads USING btree (status);


--
-- Name: idx_meetings_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_customer_id ON public.meetings USING btree (customer_id);


--
-- Name: idx_meetings_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meetings_lead_id ON public.meetings USING btree (lead_id);


--
-- Name: idx_notes_author_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_author_employee_id ON public.notes USING btree (author_employee_id) WHERE (author_employee_id IS NOT NULL);


--
-- Name: idx_notes_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_created_at ON public.notes USING btree (created_at DESC);


--
-- Name: idx_notes_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_customer_id ON public.notes USING btree (customer_id) WHERE (customer_id IS NOT NULL);


--
-- Name: idx_notes_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_project_id ON public.notes USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: idx_notes_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notes_search ON public.notes USING gin (to_tsvector('simple'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(content, ''::text))));


--
-- Name: idx_project_assignees_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_assignees_employee_id ON public.project_assignees USING btree (employee_id);


--
-- Name: idx_project_assignees_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_assignees_project_id ON public.project_assignees USING btree (project_id);


--
-- Name: idx_project_notes_project_id_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_project_notes_project_id_created_at ON public.project_notes USING btree (project_id, created_at DESC);


--
-- Name: idx_projects_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_projects_customer_id ON public.projects USING btree (customer_id);


--
-- Name: idx_quotation_items_quotation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotation_items_quotation_id ON public.quotation_items USING btree (quotation_id);


--
-- Name: idx_quotations_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_customer_id ON public.quotations USING btree (customer_id);


--
-- Name: idx_quotations_parent_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_parent_id ON public.quotations USING btree (parent_id);


--
-- Name: idx_quotations_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_project_id ON public.quotations USING btree (project_id);


--
-- Name: idx_quotations_quotation_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_quotation_date ON public.quotations USING btree (quotation_date);


--
-- Name: idx_quotations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_quotations_status ON public.quotations USING btree (status);


--
-- Name: idx_recurring_expenses_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_expenses_active ON public.recurring_expenses USING btree (is_active, day_of_month) WHERE (is_active = true);


--
-- Name: idx_recurring_expenses_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recurring_expenses_type ON public.recurring_expenses USING btree (type_id);


--
-- Name: idx_revenues_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_channel ON public.revenues USING btree (channel);


--
-- Name: idx_revenues_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_project_id ON public.revenues USING btree (project_id);


--
-- Name: idx_revenues_tax_invoice_client_reference_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_tax_invoice_client_reference_id ON public.revenues USING btree (tax_invoice_client_reference_id) WHERE (tax_invoice_client_reference_id IS NOT NULL);


--
-- Name: idx_revenues_tax_invoice_issuance_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_tax_invoice_issuance_key ON public.revenues USING btree (tax_invoice_issuance_key) WHERE (tax_invoice_issuance_key IS NOT NULL);


--
-- Name: idx_revenues_tax_invoice_issue_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_revenues_tax_invoice_issue_status ON public.revenues USING btree (tax_invoice_issue_status);


--
-- Name: idx_schedule_attendees_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedule_attendees_employee_id ON public.schedule_attendees USING btree (employee_id);


--
-- Name: idx_schedule_attendees_schedule_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedule_attendees_schedule_id ON public.schedule_attendees USING btree (schedule_id);


--
-- Name: idx_schedules_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_created_by ON public.schedules USING btree (created_by);


--
-- Name: idx_schedules_customer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_customer_id ON public.schedules USING btree (customer_id);


--
-- Name: idx_schedules_end_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_end_at ON public.schedules USING btree (end_at);


--
-- Name: idx_schedules_google_event_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_schedules_google_event_unique ON public.schedules USING btree (google_calendar_id, google_event_id);


--
-- Name: idx_schedules_lead_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_lead_id ON public.schedules USING btree (lead_id);


--
-- Name: idx_schedules_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_project_id ON public.schedules USING btree (project_id);


--
-- Name: idx_schedules_recurrence_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_recurrence_group ON public.schedules USING btree (recurrence_group_id) WHERE (recurrence_group_id IS NOT NULL);


--
-- Name: idx_schedules_slack_reminder_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_slack_reminder_pending ON public.schedules USING btree (start_at) WHERE ((slack_reminder_sent_at IS NULL) AND (all_day = false));


--
-- Name: idx_schedules_start_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_start_at ON public.schedules USING btree (start_at);


--
-- Name: idx_task_assignees_employee_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_assignees_employee_id ON public.task_assignees USING btree (employee_id);


--
-- Name: idx_task_assignees_task_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_task_assignees_task_id ON public.task_assignees USING btree (task_id);


--
-- Name: idx_tasks_date_range; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_date_range ON public.tasks USING btree (start_date, due_date);


--
-- Name: idx_tasks_due_date_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_due_date_status ON public.tasks USING btree (due_date, status) WHERE (status <> ALL (ARRAY['완료'::text, '취소'::text]));


--
-- Name: idx_tasks_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_project_id ON public.tasks USING btree (project_id);


--
-- Name: idx_tasks_sort_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_sort_order ON public.tasks USING btree (sort_order);


--
-- Name: idx_tasks_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasks_started_at ON public.tasks USING btree (started_at) WHERE (started_at IS NOT NULL);


--
-- Name: api_keys api_keys_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER api_keys_updated_at BEFORE UPDATE ON public.api_keys FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: customer_notes customer_notes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customer_notes_updated_at BEFORE UPDATE ON public.customer_notes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: customers customers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: employees employees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER employees_updated_at BEFORE UPDATE ON public.employees FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: meetings meetings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER meetings_updated_at BEFORE UPDATE ON public.meetings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: project_notes project_notes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER project_notes_updated_at BEFORE UPDATE ON public.project_notes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: projects projects_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER projects_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: revenues revenues_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER revenues_updated_at BEFORE UPDATE ON public.revenues FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: schedules schedules_reset_slack_reminder_sent_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedules_reset_slack_reminder_sent_at BEFORE UPDATE ON public.schedules FOR EACH ROW EXECUTE FUNCTION public.reset_schedule_slack_reminder_sent_at();


--
-- Name: schedules schedules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedules_updated_at BEFORE UPDATE ON public.schedules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: customer_contacts set_customer_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_customer_contacts_updated_at BEFORE UPDATE ON public.customer_contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: deposits set_deposits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_deposits_updated_at BEFORE UPDATE ON public.deposits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: expenses set_expenses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_expenses_updated_at BEFORE UPDATE ON public.expenses FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: leads set_leads_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: notes set_notes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_notes_updated_at BEFORE UPDATE ON public.notes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: quotation_items set_quotation_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_quotation_items_updated_at BEFORE UPDATE ON public.quotation_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: quotations set_quotations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_quotations_updated_at BEFORE UPDATE ON public.quotations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: recurring_expenses set_recurring_expenses_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_recurring_expenses_updated_at BEFORE UPDATE ON public.recurring_expenses FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: deposits sync_revenue_paid_from_deposit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sync_revenue_paid_from_deposit BEFORE INSERT OR UPDATE ON public.deposits FOR EACH ROW EXECUTE FUNCTION public.sync_revenue_paid_from_deposit();


--
-- Name: tasks tasks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: google_oauth_tokens trg_google_oauth_tokens_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_google_oauth_tokens_updated_at BEFORE UPDATE ON public.google_oauth_tokens FOR EACH ROW EXECUTE FUNCTION public.update_google_oauth_tokens_updated_at();


--
-- Name: app_users app_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: customer_contacts customer_contacts_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_contacts
    ADD CONSTRAINT customer_contacts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_notes customer_notes_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_notes
    ADD CONSTRAINT customer_notes_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: customer_notes customer_notes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_notes
    ADD CONSTRAINT customer_notes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: deposits deposits_revenue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT deposits_revenue_id_fkey FOREIGN KEY (revenue_id) REFERENCES public.revenues(id) ON DELETE SET NULL;


--
-- Name: employees employees_focused_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_focused_task_id_fkey FOREIGN KEY (focused_task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: expense_status_history expense_status_history_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_status_history
    ADD CONSTRAINT expense_status_history_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: expense_status_history expense_status_history_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expense_status_history
    ADD CONSTRAINT expense_status_history_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES public.expenses(id) ON DELETE CASCADE;


--
-- Name: expenses expenses_approver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_recurring_expense_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_recurring_expense_id_fkey FOREIGN KEY (recurring_expense_id) REFERENCES public.recurring_expenses(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_revenue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_revenue_id_fkey FOREIGN KEY (revenue_id) REFERENCES public.revenues(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.expense_types(id) ON DELETE SET NULL;


--
-- Name: expenses expenses_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expenses
    ADD CONSTRAINT expenses_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: google_oauth_tokens google_oauth_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: leads leads_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: leads leads_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: meetings meetings_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meetings
    ADD CONSTRAINT meetings_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: notes notes_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: notes notes_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: notes notes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notes
    ADD CONSTRAINT notes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: project_assignees project_assignees_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_assignees
    ADD CONSTRAINT project_assignees_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: project_assignees project_assignees_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_assignees
    ADD CONSTRAINT project_assignees_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: project_notes project_notes_author_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_author_employee_id_fkey FOREIGN KEY (author_employee_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: project_notes project_notes_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_notes
    ADD CONSTRAINT project_notes_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: projects projects_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.project_types(id) ON DELETE SET NULL;


--
-- Name: quotation_items quotation_items_quotation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotation_items
    ADD CONSTRAINT quotation_items_quotation_id_fkey FOREIGN KEY (quotation_id) REFERENCES public.quotations(id) ON DELETE CASCADE;


--
-- Name: quotations quotations_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: quotations quotations_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.quotations(id) ON DELETE SET NULL;


--
-- Name: quotations quotations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quotations
    ADD CONSTRAINT quotations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: recurring_expenses recurring_expenses_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_expenses
    ADD CONSTRAINT recurring_expenses_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.expense_types(id) ON DELETE SET NULL;


--
-- Name: recurring_expenses recurring_expenses_vendor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_expenses
    ADD CONSTRAINT recurring_expenses_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: revenues revenues_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenues
    ADD CONSTRAINT revenues_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: revenues revenues_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.revenues
    ADD CONSTRAINT revenues_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.project_types(id) ON DELETE SET NULL;


--
-- Name: schedule_attendees schedule_attendees_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_attendees
    ADD CONSTRAINT schedule_attendees_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: schedule_attendees schedule_attendees_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_attendees
    ADD CONSTRAINT schedule_attendees_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.schedules(id) ON DELETE CASCADE;


--
-- Name: schedules schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: schedules schedules_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: schedules schedules_lead_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES public.leads(id) ON DELETE SET NULL;


--
-- Name: schedules schedules_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT schedules_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: task_assignees task_assignees_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: task_assignees task_assignees_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_assignees
    ADD CONSTRAINT task_assignees_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: tasks tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: api_keys Authenticated users can delete api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete api_keys" ON public.api_keys FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: customer_notes Authenticated users can delete customer notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete customer notes" ON public.customer_notes FOR DELETE TO authenticated USING (true);


--
-- Name: customers Authenticated users can delete customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete customers" ON public.customers FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: deposits Authenticated users can delete deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete deposits" ON public.deposits FOR DELETE TO authenticated USING (true);


--
-- Name: employees Authenticated users can delete employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete employees" ON public.employees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: expense_types Authenticated users can delete expense_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete expense_types" ON public.expense_types FOR DELETE TO authenticated USING (true);


--
-- Name: expenses Authenticated users can delete expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete expenses" ON public.expenses FOR DELETE TO authenticated USING (true);


--
-- Name: leads Authenticated users can delete leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete leads" ON public.leads FOR DELETE TO authenticated USING (true);


--
-- Name: meetings Authenticated users can delete meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete meetings" ON public.meetings FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_notes Authenticated users can delete project notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete project notes" ON public.project_notes FOR DELETE TO authenticated USING (true);


--
-- Name: project_assignees Authenticated users can delete project_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete project_assignees" ON public.project_assignees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_types Authenticated users can delete project_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete project_types" ON public.project_types FOR DELETE TO authenticated USING (true);


--
-- Name: projects Authenticated users can delete projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete projects" ON public.projects FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: recurring_expenses Authenticated users can delete recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete recurring_expenses" ON public.recurring_expenses FOR DELETE TO authenticated USING (true);


--
-- Name: revenues Authenticated users can delete revenues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete revenues" ON public.revenues FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedule_attendees Authenticated users can delete schedule_attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete schedule_attendees" ON public.schedule_attendees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedules Authenticated users can delete schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete schedules" ON public.schedules FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: task_assignees Authenticated users can delete task_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete task_assignees" ON public.task_assignees FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: api_keys Authenticated users can insert api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert api_keys" ON public.api_keys FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: customer_notes Authenticated users can insert customer notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert customer notes" ON public.customer_notes FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: customers Authenticated users can insert customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert customers" ON public.customers FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: deposits Authenticated users can insert deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert deposits" ON public.deposits FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: employees Authenticated users can insert employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert employees" ON public.employees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: expense_status_history Authenticated users can insert expense_status_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert expense_status_history" ON public.expense_status_history FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: expense_types Authenticated users can insert expense_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert expense_types" ON public.expense_types FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: expenses Authenticated users can insert expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert expenses" ON public.expenses FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: leads Authenticated users can insert leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert leads" ON public.leads FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: meetings Authenticated users can insert meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert meetings" ON public.meetings FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: gemini_usage_logs Authenticated users can insert own gemini usage logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert own gemini usage logs" ON public.gemini_usage_logs FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_auth_uid));


--
-- Name: project_notes Authenticated users can insert project notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert project notes" ON public.project_notes FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: project_assignees Authenticated users can insert project_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert project_assignees" ON public.project_assignees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: project_types Authenticated users can insert project_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert project_types" ON public.project_types FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: projects Authenticated users can insert projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert projects" ON public.projects FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: recurring_expenses Authenticated users can insert recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert recurring_expenses" ON public.recurring_expenses FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: revenues Authenticated users can insert revenues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert revenues" ON public.revenues FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: schedule_attendees Authenticated users can insert schedule_attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert schedule_attendees" ON public.schedule_attendees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: schedules Authenticated users can insert schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert schedules" ON public.schedules FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: task_assignees Authenticated users can insert task_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can insert task_assignees" ON public.task_assignees FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: customer_contacts Authenticated users can manage customer_contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage customer_contacts" ON public.customer_contacts TO authenticated USING (true) WITH CHECK (true);


--
-- Name: quotation_items Authenticated users can manage quotation_items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage quotation_items" ON public.quotation_items TO authenticated USING (true) WITH CHECK (true);


--
-- Name: quotations Authenticated users can manage quotations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage quotations" ON public.quotations TO authenticated USING (true) WITH CHECK (true);


--
-- Name: schedule_categories Authenticated users can manage schedule_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage schedule_categories" ON public.schedule_categories TO authenticated USING (true) WITH CHECK (true);


--
-- Name: tasks Authenticated users can manage tasks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage tasks" ON public.tasks TO authenticated USING (true) WITH CHECK (true);


--
-- Name: gemini_usage_logs Authenticated users can read all gemini usage logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read all gemini usage logs" ON public.gemini_usage_logs FOR SELECT TO authenticated USING (true);


--
-- Name: deposits Authenticated users can read deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read deposits" ON public.deposits FOR SELECT TO authenticated USING (true);


--
-- Name: expense_status_history Authenticated users can read expense_status_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read expense_status_history" ON public.expense_status_history FOR SELECT TO authenticated USING (true);


--
-- Name: expense_types Authenticated users can read expense_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read expense_types" ON public.expense_types FOR SELECT TO authenticated USING (true);


--
-- Name: expenses Authenticated users can read expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read expenses" ON public.expenses FOR SELECT TO authenticated USING (true);


--
-- Name: project_types Authenticated users can read project_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read project_types" ON public.project_types FOR SELECT TO authenticated USING (true);


--
-- Name: recurring_expenses Authenticated users can read recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read recurring_expenses" ON public.recurring_expenses FOR SELECT TO authenticated USING (true);


--
-- Name: schedule_categories Authenticated users can read schedule_categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read schedule_categories" ON public.schedule_categories FOR SELECT TO authenticated USING (true);


--
-- Name: system_settings Authenticated users can read system settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read system settings" ON public.system_settings FOR SELECT TO authenticated USING (true);


--
-- Name: customer_notes Authenticated users can select customer notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select customer notes" ON public.customer_notes FOR SELECT TO authenticated USING (true);


--
-- Name: leads Authenticated users can select leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select leads" ON public.leads FOR SELECT TO authenticated USING (true);


--
-- Name: project_notes Authenticated users can select project notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can select project notes" ON public.project_notes FOR SELECT TO authenticated USING (true);


--
-- Name: api_keys Authenticated users can update api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update api_keys" ON public.api_keys FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: customer_notes Authenticated users can update customer notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update customer notes" ON public.customer_notes FOR UPDATE TO authenticated USING (true);


--
-- Name: customers Authenticated users can update customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update customers" ON public.customers FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: deposits Authenticated users can update deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update deposits" ON public.deposits FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: employees Authenticated users can update employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update employees" ON public.employees FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: expense_types Authenticated users can update expense_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update expense_types" ON public.expense_types FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: expenses Authenticated users can update expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update expenses" ON public.expenses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: leads Authenticated users can update leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update leads" ON public.leads FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: meetings Authenticated users can update meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update meetings" ON public.meetings FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_notes Authenticated users can update project notes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update project notes" ON public.project_notes FOR UPDATE TO authenticated USING (true);


--
-- Name: project_assignees Authenticated users can update project_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update project_assignees" ON public.project_assignees FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_types Authenticated users can update project_types; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update project_types" ON public.project_types FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: projects Authenticated users can update projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update projects" ON public.projects FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: recurring_expenses Authenticated users can update recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update recurring_expenses" ON public.recurring_expenses FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: revenues Authenticated users can update revenues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update revenues" ON public.revenues FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedule_attendees Authenticated users can update schedule_attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update schedule_attendees" ON public.schedule_attendees FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedules Authenticated users can update schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update schedules" ON public.schedules FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: task_assignees Authenticated users can update task_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update task_assignees" ON public.task_assignees FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: system_settings Authenticated users can upsert system settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can upsert system settings" ON public.system_settings TO authenticated USING (true) WITH CHECK (true);


--
-- Name: api_keys Authenticated users can view api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view api_keys" ON public.api_keys FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: customers Authenticated users can view customers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view customers" ON public.customers FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: employees Authenticated users can view employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view employees" ON public.employees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: meetings Authenticated users can view meetings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view meetings" ON public.meetings FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: project_assignees Authenticated users can view project_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view project_assignees" ON public.project_assignees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: projects Authenticated users can view projects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view projects" ON public.projects FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: revenues Authenticated users can view revenues; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view revenues" ON public.revenues FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedule_attendees Authenticated users can view schedule_attendees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view schedule_attendees" ON public.schedule_attendees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: schedules Authenticated users can view schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view schedules" ON public.schedules FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: task_assignees Authenticated users can view task_assignees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view task_assignees" ON public.task_assignees FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: deposits Service role full access on deposits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on deposits" ON public.deposits TO service_role USING (true) WITH CHECK (true);


--
-- Name: expense_status_history Service role full access on expense_status_history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on expense_status_history" ON public.expense_status_history TO service_role USING (true) WITH CHECK (true);


--
-- Name: expenses Service role full access on expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on expenses" ON public.expenses TO service_role USING (true) WITH CHECK (true);


--
-- Name: recurring_expenses Service role full access on recurring_expenses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access on recurring_expenses" ON public.recurring_expenses TO service_role USING (true) WITH CHECK (true);


--
-- Name: app_users Users can read own role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read own role" ON public.app_users FOR SELECT TO authenticated USING (true);


--
-- Name: api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: app_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: app_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

--
-- Name: app_logs auth_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_insert ON public.app_logs FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: app_logs auth_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auth_select ON public.app_logs FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: notes notes_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notes_insert ON public.notes FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: notes notes_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notes_select ON public.notes FOR SELECT TO authenticated USING (true);


--
-- Name: notes notes_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notes_update ON public.notes FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


--
-- Name: project_assignees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_assignees ENABLE ROW LEVEL SECURITY;

--
-- Name: project_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: project_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.project_types ENABLE ROW LEVEL SECURITY;

--
-- Name: projects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

--
-- Name: quotation_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quotation_items ENABLE ROW LEVEL SECURITY;

--
-- Name: quotations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.quotations ENABLE ROW LEVEL SECURITY;

--
-- Name: recurring_expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recurring_expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: revenues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.revenues ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_attendees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_attendees ENABLE ROW LEVEL SECURITY;

--
-- Name: schedule_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedule_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: system_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: task_assignees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_assignees ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: google_oauth_tokens 토큰 삭제; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "토큰 삭제" ON public.google_oauth_tokens FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: google_oauth_tokens 토큰 수정; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "토큰 수정" ON public.google_oauth_tokens FOR UPDATE USING (((auth.uid() = user_id) OR (is_global = true)));


--
-- Name: google_oauth_tokens 토큰 쓰기; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "토큰 쓰기" ON public.google_oauth_tokens FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: google_oauth_tokens 토큰 읽기; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "토큰 읽기" ON public.google_oauth_tokens FOR SELECT USING (((auth.uid() = user_id) OR (is_global = true)));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--



--
-- Name: FUNCTION generate_project_number(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_project_number() TO anon;
GRANT ALL ON FUNCTION public.generate_project_number() TO authenticated;
GRANT ALL ON FUNCTION public.generate_project_number() TO service_role;


--
-- Name: FUNCTION generate_quotation_number(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_quotation_number() TO anon;
GRANT ALL ON FUNCTION public.generate_quotation_number() TO authenticated;
GRANT ALL ON FUNCTION public.generate_quotation_number() TO service_role;


--
-- Name: FUNCTION normalize_business_name(value text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalize_business_name(value text) TO anon;
GRANT ALL ON FUNCTION public.normalize_business_name(value text) TO authenticated;
GRANT ALL ON FUNCTION public.normalize_business_name(value text) TO service_role;


--
-- Name: FUNCTION replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean) TO anon;
GRANT ALL ON FUNCTION public.replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean) TO authenticated;
GRANT ALL ON FUNCTION public.replace_schedule_attendees_atomic(p_schedule_ids uuid[], p_attendee_ids uuid[], p_actor_employee_id uuid, p_is_admin boolean) TO service_role;


--
-- Name: FUNCTION reset_schedule_slack_reminder_sent_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.reset_schedule_slack_reminder_sent_at() TO anon;
GRANT ALL ON FUNCTION public.reset_schedule_slack_reminder_sent_at() TO authenticated;
GRANT ALL ON FUNCTION public.reset_schedule_slack_reminder_sent_at() TO service_role;


--
-- Name: FUNCTION sync_revenue_paid_from_deposit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_revenue_paid_from_deposit() TO anon;
GRANT ALL ON FUNCTION public.sync_revenue_paid_from_deposit() TO authenticated;
GRANT ALL ON FUNCTION public.sync_revenue_paid_from_deposit() TO service_role;


--
-- Name: FUNCTION update_google_oauth_tokens_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_google_oauth_tokens_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_google_oauth_tokens_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_google_oauth_tokens_updated_at() TO service_role;


--
-- Name: FUNCTION update_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at() TO service_role;


--
-- Name: FUNCTION update_updated_at_column(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_updated_at_column() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO service_role;


--
-- Name: TABLE api_keys; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.api_keys TO anon;
GRANT ALL ON TABLE public.api_keys TO authenticated;
GRANT ALL ON TABLE public.api_keys TO service_role;


--
-- Name: TABLE app_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_logs TO anon;
GRANT ALL ON TABLE public.app_logs TO authenticated;
GRANT ALL ON TABLE public.app_logs TO service_role;


--
-- Name: TABLE app_users; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_users TO anon;
GRANT ALL ON TABLE public.app_users TO authenticated;
GRANT ALL ON TABLE public.app_users TO service_role;


--
-- Name: SEQUENCE app_users_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.app_users_id_seq TO anon;
GRANT ALL ON SEQUENCE public.app_users_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.app_users_id_seq TO service_role;


--
-- Name: TABLE customer_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_contacts TO anon;
GRANT ALL ON TABLE public.customer_contacts TO authenticated;
GRANT ALL ON TABLE public.customer_contacts TO service_role;


--
-- Name: TABLE customer_notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customer_notes TO anon;
GRANT ALL ON TABLE public.customer_notes TO authenticated;
GRANT ALL ON TABLE public.customer_notes TO service_role;


--
-- Name: TABLE customers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.customers TO anon;
GRANT ALL ON TABLE public.customers TO authenticated;
GRANT ALL ON TABLE public.customers TO service_role;


--
-- Name: TABLE deposits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.deposits TO anon;
GRANT ALL ON TABLE public.deposits TO authenticated;
GRANT ALL ON TABLE public.deposits TO service_role;


--
-- Name: TABLE employees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.employees TO anon;
GRANT ALL ON TABLE public.employees TO authenticated;
GRANT ALL ON TABLE public.employees TO service_role;


--
-- Name: TABLE expense_status_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_status_history TO anon;
GRANT ALL ON TABLE public.expense_status_history TO authenticated;
GRANT ALL ON TABLE public.expense_status_history TO service_role;


--
-- Name: TABLE expense_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expense_types TO anon;
GRANT ALL ON TABLE public.expense_types TO authenticated;
GRANT ALL ON TABLE public.expense_types TO service_role;


--
-- Name: TABLE expenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.expenses TO anon;
GRANT ALL ON TABLE public.expenses TO authenticated;
GRANT ALL ON TABLE public.expenses TO service_role;


--
-- Name: TABLE gemini_usage_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.gemini_usage_logs TO anon;
GRANT ALL ON TABLE public.gemini_usage_logs TO authenticated;
GRANT ALL ON TABLE public.gemini_usage_logs TO service_role;


--
-- Name: TABLE google_oauth_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.google_oauth_tokens TO anon;
GRANT ALL ON TABLE public.google_oauth_tokens TO authenticated;
GRANT ALL ON TABLE public.google_oauth_tokens TO service_role;


--
-- Name: TABLE leads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.leads TO anon;
GRANT ALL ON TABLE public.leads TO authenticated;
GRANT ALL ON TABLE public.leads TO service_role;


--
-- Name: TABLE meetings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.meetings TO anon;
GRANT ALL ON TABLE public.meetings TO authenticated;
GRANT ALL ON TABLE public.meetings TO service_role;


--
-- Name: TABLE notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notes TO anon;
GRANT ALL ON TABLE public.notes TO authenticated;
GRANT ALL ON TABLE public.notes TO service_role;


--
-- Name: TABLE project_assignees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.project_assignees TO anon;
GRANT ALL ON TABLE public.project_assignees TO authenticated;
GRANT ALL ON TABLE public.project_assignees TO service_role;


--
-- Name: TABLE project_notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.project_notes TO anon;
GRANT ALL ON TABLE public.project_notes TO authenticated;
GRANT ALL ON TABLE public.project_notes TO service_role;


--
-- Name: TABLE project_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.project_types TO anon;
GRANT ALL ON TABLE public.project_types TO authenticated;
GRANT ALL ON TABLE public.project_types TO service_role;


--
-- Name: TABLE projects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.projects TO anon;
GRANT ALL ON TABLE public.projects TO authenticated;
GRANT ALL ON TABLE public.projects TO service_role;


--
-- Name: TABLE quotation_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.quotation_items TO anon;
GRANT ALL ON TABLE public.quotation_items TO authenticated;
GRANT ALL ON TABLE public.quotation_items TO service_role;


--
-- Name: TABLE quotations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.quotations TO anon;
GRANT ALL ON TABLE public.quotations TO authenticated;
GRANT ALL ON TABLE public.quotations TO service_role;


--
-- Name: TABLE recurring_expenses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.recurring_expenses TO anon;
GRANT ALL ON TABLE public.recurring_expenses TO authenticated;
GRANT ALL ON TABLE public.recurring_expenses TO service_role;


--
-- Name: TABLE revenues; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.revenues TO anon;
GRANT ALL ON TABLE public.revenues TO authenticated;
GRANT ALL ON TABLE public.revenues TO service_role;


--
-- Name: TABLE schedule_attendees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schedule_attendees TO anon;
GRANT ALL ON TABLE public.schedule_attendees TO authenticated;
GRANT ALL ON TABLE public.schedule_attendees TO service_role;


--
-- Name: TABLE schedule_categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schedule_categories TO anon;
GRANT ALL ON TABLE public.schedule_categories TO authenticated;
GRANT ALL ON TABLE public.schedule_categories TO service_role;


--
-- Name: TABLE schedules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.schedules TO anon;
GRANT ALL ON TABLE public.schedules TO authenticated;
GRANT ALL ON TABLE public.schedules TO service_role;


--
-- Name: TABLE system_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_settings TO anon;
GRANT ALL ON TABLE public.system_settings TO authenticated;
GRANT ALL ON TABLE public.system_settings TO service_role;


--
-- Name: TABLE task_assignees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.task_assignees TO anon;
GRANT ALL ON TABLE public.task_assignees TO authenticated;
GRANT ALL ON TABLE public.task_assignees TO service_role;


--
-- Name: TABLE tasks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tasks TO anon;
GRANT ALL ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--


