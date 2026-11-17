/**
 * API 응답에 실을 오류 문구를 고른다.
 *
 * 서버가 일부러 만든 한국어 안내("상태 '요청'에서 '지급'으로 바꿀 수 없습니다" 등)는 그대로 보여 주고,
 * DB·라이브러리 내부 오류 원문(테이블·컬럼 이름, SQL, 스택, 네트워크 주소 등)은 응답에 싣지 않는다.
 * 원문은 서버 로그(console.error)에만 남긴다.
 */
const INTERNAL_PATTERNS = [
  /relation|column|schema|syntax|violates|duplicate key|constraint|foreign key|null value/i,
  /PGRST|postgres|JWT/i,
  /\bat\s+\S+\s*\(|node_modules|\.ts:\d+|\.js:\d+/,
  /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|socket|https?:\/\//i,
  /Cannot read|undefined|is not a function|Unexpected token|JSON/i,
  /invalid input|out of range|permission denied|row-level security/i,
];

function rawMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

export function isPublicErrorMessage(message: string): boolean {
  if (!message || message.length > 300) return false;
  if (!/[가-힣]/.test(message)) return false;
  return !INTERNAL_PATTERNS.some((pattern) => pattern.test(message));
}

export function publicErrorMessage(error: unknown, fallback = "요청을 처리하지 못했습니다."): string {
  const message = rawMessage(error).trim();
  if (isPublicErrorMessage(message)) return message;
  if (message) console.error("[api-error]", message);
  return fallback;
}
