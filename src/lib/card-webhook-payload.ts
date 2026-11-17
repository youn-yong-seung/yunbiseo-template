const CARD_WEBHOOK_TEXT_KEYS = [
  "text",
  "sms_body",
  "body",
  "message",
  "notification_text",
  "evtprm3",
  "evtprm2",
  "sender",
  "evtprm1",
  "title",
  "notification_title",
] as const;

const HIDDEN_NOTIFICATION_TEXTS = new Set([
  "민감한 알림 콘텐츠 숨김",
  "메시지 보기",
  "메시지",
]);

type CardWebhookPayloadInput = {
  readonly contentType: string;
  readonly bodyRaw: string;
};

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function scoreWebhookText(text: string): number {
  let score = 0;

  if (HIDDEN_NOTIFICATION_TEXTS.has(text)) score -= 100;
  if (/NH(?:기업|개인|카드)\s*\d{4}/i.test(text)) score += 60;
  if (/승인|승인취소|해외승인/.test(text)) score += 40;
  if (/\b(?:USD|EUR|JPY|CNY|GBP|AUD|CAD|HKD|SGD|THB|VND)\s+[0-9]+/i.test(text)) {
    score += 25;
  }
  if (/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원/.test(text)) score += 15;
  if (/\d{1,2}\s*[/\-월]\s*\d{1,2}\s*[일]?\s*\d{1,2}:\d{2}/.test(text)) {
    score += 15;
  }
  if (/^\[?Web발신\]?$/m.test(text)) score += 5;

  return score;
}

export function selectCardWebhookText(candidates: readonly string[]): string {
  let bestText = "";
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (!text) continue;

    const score = scoreWebhookText(text);
    if (!bestText || score > bestScore) {
      bestText = text;
      bestScore = score;
    }
  }

  return bestScore <= -100 ? "" : bestText;
}

function collectFormCandidates(bodyRaw: string): readonly string[] {
  const params = new URLSearchParams(bodyRaw);
  const candidates: string[] = [];

  for (const key of CARD_WEBHOOK_TEXT_KEYS) {
    candidates.push(...params.getAll(key));
  }

  return candidates;
}

function isObjectRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectJsonCandidates(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (!isObjectRecord(value)) return [];

  const entries = Object.entries(value);
  const candidates: string[] = [];

  for (const key of CARD_WEBHOOK_TEXT_KEYS) {
    const matched = entries.find(([entryKey]) => entryKey.toLowerCase() === key);
    const entryValue = matched?.[1];
    if (typeof entryValue === "string") candidates.push(entryValue);
  }

  return candidates;
}

export function extractCardWebhookText({
  contentType,
  bodyRaw,
}: CardWebhookPayloadInput): string {
  const normalizedContentType = contentType.toLowerCase();

  if (normalizedContentType.includes("application/x-www-form-urlencoded")) {
    return selectCardWebhookText(collectFormCandidates(bodyRaw));
  }

  if (normalizedContentType.includes("application/json")) {
    try {
      return selectCardWebhookText(collectJsonCandidates(JSON.parse(bodyRaw)));
    } catch (error) {
      if (error instanceof SyntaxError) return normalizeText(bodyRaw);
      throw error;
    }
  }

  return normalizeText(bodyRaw);
}
