import { BadRequest, normalizeText, parseDate, resolveProjectRef, type Admin } from "@/lib/yb-api/refs";

/** yb 가 읽는 매출 모양: 프로젝트 번호·이름과 고객 이름을 함께 싣는다. */
export const REVENUE_SELECT =
  "*, projects(id, project_number, name, client, customer_id, customers(id, name))";

const VALID_CHANNELS = ["아임웹", "자사몰", "기타"];

export function parseInteger(value: unknown, fieldName: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(String(value).replace(/,/g, ""), 10);
  if (!Number.isFinite(parsed)) throw new BadRequest(`${fieldName} must be an integer`);
  return parsed;
}

export function parseBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  const normalized = String(value).toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  throw new BadRequest(`true 또는 false 로 입력해 주세요: ${value}`);
}

/** 한국 시간 기준 오늘(YYYY-MM-DD). */
export function todayKst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

type Amounts = { total_amount: number; supply_amount: number; vat_amount: number };

/**
 * 합계·공급가·부가세 중 준 값으로 나머지를 채운다.
 * 합계만 주면 부가세 10% 포함으로 보고 나눈다. 수정할 때는 안 준 값은 기존 값을 쓴다.
 */
export function resolveAmounts(body: Record<string, unknown>, current?: Amounts): Amounts | null {
  const total = parseInteger(body.total_amount, "total_amount");
  let supply = parseInteger(body.supply_amount, "supply_amount");
  let vat = parseInteger(body.vat_amount, "vat_amount");
  if (total === null && supply === null && vat === null) return null;

  if (total !== null) {
    if (supply === null && vat === null) {
      supply = Math.round(total / 1.1);
      vat = total - supply;
    } else if (supply === null) {
      supply = total - (vat as number);
    } else if (vat === null) {
      vat = total - supply;
    }
    if ((supply as number) + (vat as number) !== total) {
      throw new BadRequest("supply_amount + vat_amount must equal total_amount");
    }
    return { total_amount: total, supply_amount: supply as number, vat_amount: vat as number };
  }

  // 합계 없이 공급가·부가세만 바꾸면 합계를 다시 계산한다.
  const nextSupply = supply ?? current?.supply_amount ?? 0;
  const nextVat = vat ?? (supply !== null && !current ? Math.round(supply * 0.1) : current?.vat_amount ?? 0);
  return { total_amount: nextSupply + nextVat, supply_amount: nextSupply, vat_amount: nextVat };
}

/** 요청 본문에서 매출 필드만 골라 검증한다(금액·세금계산서 상태는 따로 다룬다). */
export async function pickRevenueFields(supabase: Admin, body: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = normalizeText(body.title);
    if (!title) throw new BadRequest("title cannot be empty");
    fields.title = title;
  }
  if (body.memo !== undefined) fields.memo = normalizeText(body.memo);
  if (body.revenue_date !== undefined) fields.revenue_date = parseDate(body.revenue_date, "revenue_date");
  if (body.expected_payment_date !== undefined) {
    fields.expected_payment_date = parseDate(body.expected_payment_date, "expected_payment_date");
  }

  if (body.project_id !== undefined) {
    const ref = normalizeText(body.project_id);
    if (ref) {
      // uuid 대신 프로젝트 번호(26-3)를 줘도 된다.
      const projectId = await resolveProjectRef(supabase, ref);
      if (!projectId) throw new BadRequest(`project not found: ${ref}`);
      const { data } = await supabase.from("projects").select("id").eq("id", projectId).maybeSingle();
      if (!data) throw new BadRequest(`project not found: ${ref}`);
      fields.project_id = projectId;
    } else {
      fields.project_id = null;
    }
  }

  if (body.channel !== undefined) {
    const channel = normalizeText(body.channel);
    if (channel && !VALID_CHANNELS.includes(channel)) {
      throw new BadRequest(`channel must be one of ${VALID_CHANNELS.join(", ")}`);
    }
    fields.channel = channel;
  }
  if (body.product_name !== undefined) fields.product_name = normalizeText(body.product_name);
  if (body.external_order_id !== undefined) fields.external_order_id = normalizeText(body.external_order_id);

  const isPaid = parseBoolean(body.is_paid);
  if (isPaid !== null) {
    fields.is_paid = isPaid;
    fields.paid_date = isPaid ? parseDate(body.paid_date, "paid_date") ?? todayKst() : null;
  } else if (body.paid_date !== undefined) {
    const paidDate = parseDate(body.paid_date, "paid_date");
    fields.paid_date = paidDate;
    if (paidDate) fields.is_paid = true;
  }

  const notRequired = parseBoolean(body.tax_invoice_not_required);
  if (notRequired !== null) fields.tax_invoice_not_required = notRequired;

  // 볼타 없이 홈택스에서 직접 발행했다면 여기로 '발행함'만 표시한다.
  const issued = parseBoolean(body.is_tax_invoice_issued);
  if (issued !== null) {
    fields.is_tax_invoice_issued = issued;
    fields.tax_invoice_date = issued ? parseDate(body.tax_invoice_date, "tax_invoice_date") ?? todayKst() : null;
  } else if (body.tax_invoice_date !== undefined) {
    const date = parseDate(body.tax_invoice_date, "tax_invoice_date");
    fields.tax_invoice_date = date;
    if (date) fields.is_tax_invoice_issued = true;
  }

  return fields;
}
