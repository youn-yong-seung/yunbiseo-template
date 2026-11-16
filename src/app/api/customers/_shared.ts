import { BadRequest, normalizeText } from "@/lib/yb-api/refs";

export const CUSTOMER_TYPES = ["개인", "개인사업자", "법인"] as const;
export const TAX_CATEGORIES = ["personal_withholding", "business_vat", "corporate_vat", "none"] as const;

export const CUSTOMER_SELECT =
  "id, customer_type, name, representative_name, business_number, contact_name, contact_email, contact_phone, address, memo, tax_category, default_withholding_rate, bank_name, account_number, account_holder, is_vendor, created_at, updated_at";

/** 원천징수율: 0.033 처럼 소수로 저장한다. 3.3 처럼 퍼센트로 주면 100으로 나눈다. */
function toWithholdingFraction(value: unknown): number | null {
  const text = normalizeText(value);
  if (text === null) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) throw new BadRequest("default_withholding_rate must be a number");
  return parsed >= 1 ? Number((parsed / 100).toFixed(4)) : parsed;
}

/**
 * 요청 본문에서 고객 필드만 골라 검증한다. 준 필드만 담는다(PATCH 에서 안 준 값은 그대로 둔다).
 */
export function pickCustomerFields(body: Record<string, unknown>) {
  const fields: Record<string, unknown> = {};
  const textFields = [
    "name",
    "representative_name",
    "business_number",
    "contact_name",
    "contact_email",
    "contact_phone",
    "address",
    "memo",
    "bank_name",
    "account_number",
    "account_holder",
  ];
  for (const key of textFields) {
    if (body[key] !== undefined) fields[key] = normalizeText(body[key]);
  }
  if (body.customer_type !== undefined) {
    let type = normalizeText(body.customer_type);
    if (type === "회사") type = "법인";
    if (type && !(CUSTOMER_TYPES as readonly string[]).includes(type)) {
      throw new BadRequest(`customer_type must be one of ${CUSTOMER_TYPES.join(", ")}`);
    }
    fields.customer_type = type;
  }
  if (body.tax_category !== undefined) {
    const category = normalizeText(body.tax_category);
    if (category && !(TAX_CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequest(`tax_category must be one of ${TAX_CATEGORIES.join(", ")}`);
    }
    fields.tax_category = category;
  }
  if (body.default_withholding_rate !== undefined) {
    fields.default_withholding_rate = toWithholdingFraction(body.default_withholding_rate);
  }
  return fields;
}

const CONTACT_FIELDS = ["name", "position", "phone", "email", "memo"] as const;

export function pickContactFields(body: Record<string, unknown>) {
  const fields: Record<string, string | null> = {};
  for (const key of CONTACT_FIELDS) {
    if (body[key] !== undefined) fields[key] = normalizeText(body[key]);
  }
  return fields;
}
