import { SupabaseClient } from "@supabase/supabase-js";

type GoogleTokenRow = {
  id: string;
  gmail_email: string;
  access_token: string;
  refresh_token: string;
  token_expiry: string;
};

function toTokenPayload(
  supabase: SupabaseClient,
  token: GoogleTokenRow | null
) {
  if (!token) return null;

  const onTokenRefreshed = async (newAccessToken: string, newExpiry: number) => {
    const { error } = await supabase
      .from("google_oauth_tokens")
      .update({
        access_token: newAccessToken,
        token_expiry: new Date(newExpiry).toISOString(),
      })
      .eq("id", token.id);

    if (error) {
      console.error("[GoogleToken] 토큰 갱신 DB 저장 실패:", error.message);
    }
  };

  return {
    id: token.id,
    email: token.gmail_email,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiryDate: new Date(token.token_expiry).getTime(),
    onTokenRefreshed,
  };
}

/**
 * 일정(구글 캘린더)용 토큰. 본인이 연결한 토큰을 먼저 쓰고, 없으면 관리자가 회사 공용으로 연결한 토큰(is_global)을 쓴다.
 * supabase 는 service role 클라이언트여야 한다(google_oauth_tokens 는 브라우저 정책이 없다).
 */
export async function getGoogleOAuthToken(
  supabase: SupabaseClient,
  userId: string
) {
  const { data: own } = await supabase
    .from("google_oauth_tokens")
    .select("id, gmail_email, access_token, refresh_token, token_expiry")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  if (own) return toTokenPayload(supabase, own as GoogleTokenRow);

  return getGlobalGoogleOAuthToken(supabase);
}

export async function getGlobalGoogleOAuthToken(supabase: SupabaseClient) {
  const { data: token } = await supabase
    .from("google_oauth_tokens")
    .select("id, gmail_email, access_token, refresh_token, token_expiry")
    .eq("is_global", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return toTokenPayload(supabase, token as GoogleTokenRow | null);
}
