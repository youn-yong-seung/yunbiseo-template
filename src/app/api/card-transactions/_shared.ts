import { BadRequest, NotFound, UUID_RE, normalizeText, type Admin } from "@/lib/yb-api/refs";

/** yb 가 읽는 카드내역 모양: 카드 별칭과 카드 주인 이름을 함께 싣는다. */
export const CARD_TX_SELECT =
  "*, corporate_cards(id, alias, last4, issuer, employees(id, name))";

export const CARD_TX_STATUSES = ["pending", "confirmed", "ignored"] as const;

/** 끝 4자리로 쓰는 카드를 찾는다. 등록 안 된 카드면 null(내역은 그대로 남긴다). */
export async function findActiveCardId(supabase: Admin, last4: string | null) {
  if (!last4) return null;
  const { data } = await supabase
    .from("corporate_cards")
    .select("id")
    .eq("last4", last4)
    .eq("is_active", true)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

function parseApprovedAt(value: unknown): string {
  const text = normalizeText(value);
  if (!text) throw new BadRequest("approved_at cannot be empty");
  // 날짜만 주면 한국 시간 정오로 둔다(날짜가 하루 밀리지 않게).
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T12:00:00+09:00` : text;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new BadRequest("approved_at must be a date (YYYY-MM-DD or ISO)");
  return date.toISOString();
}

/** 요청 본문에서 카드내역 필드만 골라 검증한다. */
export async function pickCardTxFields(supabase: Admin, body: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};

  if (body.amount !== undefined) {
    const amount = Number.parseInt(String(body.amount).replace(/,/g, ""), 10);
    if (!Number.isFinite(amount)) throw new BadRequest("amount must be an integer");
    fields.amount = amount;
  }
  if (body.merchant !== undefined) fields.merchant = normalizeText(body.merchant);
  if (body.description !== undefined) fields.description = normalizeText(body.description);
  if (body.receipt_url !== undefined) fields.receipt_url = normalizeText(body.receipt_url);
  if (body.approved_at !== undefined) fields.approved_at = parseApprovedAt(body.approved_at);
  if (body.currency !== undefined) fields.currency = (normalizeText(body.currency) ?? "KRW").toUpperCase();
  if (body.foreign_amount !== undefined) {
    const text = normalizeText(body.foreign_amount);
    const value = text === null ? null : Number(text.replace(/,/g, ""));
    if (value !== null && !Number.isFinite(value)) throw new BadRequest("foreign_amount must be a number");
    fields.foreign_amount = value;
  }
  if (body.status !== undefined) {
    const status = normalizeText(body.status);
    if (!status || !(CARD_TX_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequest(`status must be one of ${CARD_TX_STATUSES.join(", ")}`);
    }
    fields.status = status;
  }

  const cardRef = normalizeText(body.card_id);
  const last4 = normalizeText(body.card_last4);
  if (cardRef) {
    if (!UUID_RE.test(cardRef)) throw new BadRequest("card_id must be a uuid");
    const { data } = await supabase.from("corporate_cards").select("id, last4").eq("id", cardRef).maybeSingle();
    if (!data) throw new BadRequest(`card not found: ${cardRef}`);
    fields.card_id = data.id;
    fields.card_last4 = data.last4;
  } else if (last4 !== null) {
    if (!/^\d{4}$/.test(last4)) throw new BadRequest("card_last4 must be 4 digits");
    fields.card_last4 = last4;
    fields.card_id = await findActiveCardId(supabase, last4);
  }

  return fields;
}

export async function selectCardTx(supabase: Admin, id: string) {
  if (!UUID_RE.test(id)) throw new NotFound("Card transaction not found");
  const { data, error } = await supabase.from("card_transactions").select(CARD_TX_SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Card transaction not found");
  return data;
}

/** 한국 날짜(YYYY-MM-DD)의 시작·끝을 UTC ISO 로. */
export function kstDayStart(date: string) {
  return new Date(`${date}T00:00:00+09:00`).toISOString();
}
export function kstDayEnd(date: string) {
  return new Date(`${date}T23:59:59.999+09:00`).toISOString();
}
