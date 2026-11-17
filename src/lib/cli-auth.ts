import { createHash, randomInt, timingSafeEqual } from "crypto";

/** 확인 코드: 헷갈리는 글자(0 O 1 I L)를 뺀 8자, 4자씩 하이픈. 예: K7MQ-X9PD */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateUserCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)];
  const raw = Array.from({ length: 8 }, pick).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** 입력한 확인 코드를 비교용으로: 대문자, 하이픈·공백 제거. */
export function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashUserCode(value: string): string {
  return createHash("sha256").update(`yb-user-code:${normalizeUserCode(value)}`).digest("hex");
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const CLI_KEY_DAYS = 90;
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
export const REQUEST_TTL_SECONDS = 600;
