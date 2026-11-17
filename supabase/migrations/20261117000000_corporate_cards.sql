-- 법인카드와 카드 사용내역(적요)
-- 카드 승인 문자를 폰(아이폰 단축어, 안드로이드 MacroDroid)이 /api/card-transactions/webhook 으로 보내면
-- 서버가 금액·가맹점·승인시각·카드 끝 4자리를 읽어 한 줄을 만든다. 사용자는 적요(어디에 썼는지)를 채운다.

create table public.corporate_cards (
  id uuid primary key default gen_random_uuid(),
  alias text,                                         -- 별칭 (예: 대표 카드)
  last4 text not null check (last4 ~ '^[0-9]{4}$'),    -- 문자에 찍히는 카드 끝 4자리
  holder_employee_id uuid references public.employees(id) on delete set null,
  issuer text,                                        -- 카드사 (예: 신한)
  is_active boolean not null default true,
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 쓰는 카드 중에서는 끝 4자리가 겹치면 안 된다(문자와 카드를 잇는 열쇠).
create unique index uq_corporate_cards_active_last4
  on public.corporate_cards(last4)
  where is_active = true;

create trigger set_corporate_cards_updated_at
  before update on public.corporate_cards
  for each row execute function public.update_updated_at();

create table public.card_transactions (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.corporate_cards(id) on delete set null,
  card_last4 text,                                    -- 카드 매칭이 안 돼도 남긴다
  issuer text,
  amount integer not null,                            -- 원화 금액, 취소는 음수
  currency text not null default 'KRW',
  foreign_amount numeric(14, 2),                      -- 해외 결제 외화 금액
  merchant text,
  approved_at timestamptz not null,
  description text,                                   -- 적요 (예: 고객 미팅 커피 3잔)
  receipt_url text,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'ignored')),
  is_cancellation boolean not null default false,
  source text not null default 'webhook'
    check (source in ('webhook', 'manual')),
  raw_text text,                                      -- 받은 문자 원문
  parse_status text not null default 'parsed'
    check (parse_status in ('parsed', 'partial', 'failed')),
  dedupe_key text,                                    -- 같은 문자가 두 번 와도 한 줄만
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index uq_card_transactions_dedupe_key
  on public.card_transactions(dedupe_key)
  where dedupe_key is not null;
create index idx_card_transactions_approved_at on public.card_transactions(approved_at desc);
create index idx_card_transactions_card_id on public.card_transactions(card_id);

create trigger set_card_transactions_updated_at
  before update on public.card_transactions
  for each row execute function public.update_updated_at();

alter table public.corporate_cards enable row level security;
alter table public.card_transactions enable row level security;

create policy "Authenticated users can read corporate_cards" on public.corporate_cards
  for select to authenticated using (true);
create policy "Authenticated users can insert corporate_cards" on public.corporate_cards
  for insert to authenticated with check (true);
create policy "Authenticated users can update corporate_cards" on public.corporate_cards
  for update to authenticated using (true) with check (true);
create policy "Authenticated users can delete corporate_cards" on public.corporate_cards
  for delete to authenticated using (true);
create policy "Service role full access on corporate_cards" on public.corporate_cards
  to service_role using (true) with check (true);

create policy "Authenticated users can read card_transactions" on public.card_transactions
  for select to authenticated using (true);
create policy "Authenticated users can insert card_transactions" on public.card_transactions
  for insert to authenticated with check (true);
create policy "Authenticated users can update card_transactions" on public.card_transactions
  for update to authenticated using (true) with check (true);
create policy "Authenticated users can delete card_transactions" on public.card_transactions
  for delete to authenticated using (true);
create policy "Service role full access on card_transactions" on public.card_transactions
  to service_role using (true) with check (true);
