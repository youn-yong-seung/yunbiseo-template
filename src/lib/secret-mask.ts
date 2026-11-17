/**
 * 설정 화면에 외부 서비스 키를 그대로 내려보내지 않기 위한 도구.
 * GET 은 "••••••••끝4자리" 로 가려서 보내고, PUT 에 같은 가린 값이 돌아오면 "바꾸지 않음"으로 본다.
 */
export const SECRET_MASK_PREFIX = "••••••••";

export function maskSecret(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  if (!text) return "";
  return `${SECRET_MASK_PREFIX}${text.length > 8 ? text.slice(-4) : ""}`;
}

export function isMaskedSecret(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(SECRET_MASK_PREFIX);
}

/** 설정값 저장 계획: 가린 값은 건너뛰고, 빈 값은 지우고, 나머지는 저장한다. */
export function planSettingWrites(values: Record<string, string>) {
  const now = new Date().toISOString();
  const upsertRows: { key: string; value: string; updated_at: string }[] = [];
  const deleteKeys: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    if (isMaskedSecret(raw)) continue;
    const value = raw.trim();
    if (value) upsertRows.push({ key, value, updated_at: now });
    else deleteKeys.push(key);
  }
  return { upsertRows, deleteKeys };
}
