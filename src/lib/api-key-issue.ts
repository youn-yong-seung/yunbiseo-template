import type { SupabaseClient } from "@supabase/supabase-js";

import { generateApiKey, getKeyPrefix, hashApiKey } from "@/lib/api-key";

export interface IssuedApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_by: string;
  employee_id: string;
  created_at: string;
  expires_at: string | null;
  /** 원문 키 — 이 반환값에서만 1회 제공된다. 로그·저장 금지. */
  raw_key: string;
}

/**
 * API 키를 생성해 api_keys 에 저장하고 원문을 1회 반환한다.
 * 웹 UI(POST /api/api-keys)와 yb login(cli-auth/exchange)이 공통으로 사용한다.
 * 키 주인은 employee_id 로 묶는다. created_by(이름)는 표시용이다.
 * DB 에는 sha256 해시와 앞 12자(key_prefix)만 저장한다. 원문은 되살릴 수 없으므로, 잃어버리면 지우고 새로 만든다.
 * supabase 는 service role 클라이언트여야 한다(api_keys 는 브라우저 정책이 없다).
 * 만료일은 필수다(DB 제약 api_keys_expires_required).
 */
export async function issueApiKey(
  supabase: SupabaseClient,
  {
    name,
    employeeId,
    employeeName,
    expiresAt,
  }: { name: string; employeeId: string; employeeName: string; expiresAt: string }
): Promise<IssuedApiKey> {
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = getKeyPrefix(rawKey);

  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      name: name.slice(0, 100),
      key_hash: keyHash,
      key_prefix: keyPrefix,
      created_by: employeeName,
      employee_id: employeeId,
      expires_at: expiresAt,
    })
    .select("id, name, key_prefix, created_by, employee_id, created_at, expires_at")
    .single();

  if (error || !data) {
    throw new Error("API 키 생성에 실패했습니다.");
  }

  return { ...data, raw_key: rawKey } as IssuedApiKey;
}
