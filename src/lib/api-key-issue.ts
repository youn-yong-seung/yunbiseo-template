import type { SupabaseClient } from "@supabase/supabase-js";

import { generateApiKey, getKeyPrefix, hashApiKey } from "@/lib/api-key";
import { encryptApiKey } from "@/lib/api-key-secret";

export interface IssuedApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_by: string;
  created_at: string;
  /** 원문 키 — 이 반환값에서만 1회 제공된다. 로그·저장 금지. */
  raw_key: string;
}

/**
 * API 키를 생성해 api_keys 에 저장하고 원문을 1회 반환한다.
 * 웹 UI(POST /api/api-keys)와 yb login(cli-auth/exchange)이 공통으로 사용한다.
 */
export async function issueApiKey(
  supabase: SupabaseClient,
  { name, createdBy }: { name: string; createdBy: string }
): Promise<IssuedApiKey> {
  const rawKey = generateApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = getKeyPrefix(rawKey);
  const keyEncrypted = encryptApiKey(rawKey);

  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      name,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      key_encrypted: keyEncrypted,
      created_by: createdBy,
    })
    .select("id, name, key_prefix, created_by, created_at")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "API 키 생성에 실패했습니다.");
  }

  return { ...data, raw_key: rawKey } as IssuedApiKey;
}
