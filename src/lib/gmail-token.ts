import { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Gmail API 호출에 필요한 토큰을 조회하고, 토큰 갱신 시 DB에 자동 저장하는 콜백을 반환합니다.
 *
 * 메일은 개인 데이터다. 로그인한 본인이 연결한 토큰만 쓴다(다른 직원·회사 공용 토큰으로 메일을 읽지 않는다).
 * google_oauth_tokens 는 브라우저 정책이 없어 서버(service role)만 읽는다. 첫 인자는 호환용으로 남겨 둔다.
 */
export async function getGmailToken(_supabase: SupabaseClient | null, userId: string) {
  const admin = createAdminClient();
  const { data: token } = await admin
    .from("google_oauth_tokens")
    .select("id, access_token, refresh_token, token_expiry")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (!token) return null;

  const onTokenRefreshed = async (newAccessToken: string, newExpiry: number) => {
    await admin
      .from("google_oauth_tokens")
      .update({
        access_token: newAccessToken,
        token_expiry: new Date(newExpiry).toISOString(),
      })
      .eq("id", token.id);
  };

  return {
    tokenId: token.id as string,
    userId,
    accessToken: token.access_token as string,
    refreshToken: token.refresh_token as string,
    expiryDate: new Date(token.token_expiry).getTime(),
    onTokenRefreshed,
  };
}

/** 만료/폐기된 본인 토큰을 DB에서 삭제하여 재연결 UI가 표시되도록 합니다. */
export async function deleteGmailToken(_supabase: SupabaseClient | null, tokenId: string, userId?: string) {
  let query = createAdminClient().from("google_oauth_tokens").delete().eq("id", tokenId);
  if (userId) query = query.eq("user_id", userId);
  await query;
}
