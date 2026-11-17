import { createHmac, timingSafeEqual } from "crypto";

/**
 * Standard Webhooks(https://www.standardwebhooks.com) 서명 검증. 볼타 웹훅이 이 규격으로 서명한다.
 *
 * - 헤더: webhook-id, webhook-timestamp(Unix 초), webhook-signature("v1,<base64>" 여러 개면 공백 구분)
 * - 서명 대상: `${id}.${timestamp}.${가공 전 원문 본문}`
 * - 키: "whsec_" 뒤 base64 를 디코드한 바이트, HMAC-SHA256 → base64
 * - 시각이 지금과 5분 넘게 차이 나면 거부(오래된 요청 재사용 방지)
 */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookVerifyResult =
  | { ok: true; id: string; timestamp: number }
  | { ok: false; reason: "missing_headers" | "bad_secret" | "bad_timestamp" | "stale_timestamp" | "bad_signature" };

function decodeSecret(secret: string): Buffer | null {
  const trimmed = secret.trim();
  const base64 = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const key = Buffer.from(base64, "base64");
  return key.length >= 16 ? key : null;
}

export function signStandardWebhook(secret: string, id: string, timestamp: number, rawBody: string): string {
  const key = decodeSecret(secret);
  if (!key) throw new Error("invalid secret");
  return createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
}

export function verifyStandardWebhook(
  secret: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): WebhookVerifyResult {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };
  if (id.length > 200 || signature.length > 2000) return { ok: false, reason: "missing_headers" };

  const key = decodeSecret(secret);
  if (!key) return { ok: false, reason: "bad_secret" };

  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const ts = Number(timestamp);
  if (Math.abs(nowSeconds - ts) > WEBHOOK_TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  const matched = signature
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .some((part) => {
      let given: Buffer;
      try {
        given = Buffer.from(part.slice(3), "base64");
      } catch {
        return false;
      }
      return given.length === expected.length && timingSafeEqual(given, expected);
    });

  return matched ? { ok: true, id, timestamp: ts } : { ok: false, reason: "bad_signature" };
}
