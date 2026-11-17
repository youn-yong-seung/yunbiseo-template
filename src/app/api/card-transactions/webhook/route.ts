import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";
import { validateApiKey } from "@/lib/api-key";
import { parseCardSms } from "@/lib/card-sms-parser";
import { extractCardWebhookText } from "@/lib/card-webhook-payload";
import { logError, logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { CARD_TX_SELECT, findActiveCardId } from "../_shared";

/**
 * 카드 승인 문자 받기: POST /api/card-transactions/webhook  (헤더 x-api-key 필수)
 *
 * 본문은 문자 원문 그대로(text/plain) 또는 {"text": "문자 원문"}(JSON) 둘 다 된다.
 * 아이폰 단축어, 안드로이드 MacroDroid 설정은 SETUP.md '법인카드 문자 연동'을 본다.
 *
 * - 카드 문자가 아니거나(인증번호 등) 잔액 부족 문자면 저장하지 않고 skipped 로 답한다.
 * - 같은 문자가 두 번 와도 한 줄만 남는다(duplicate: true).
 * - 승인 취소 문자가 오면 원래 승인 건을 찾아 둘 다 '무시'로 바꾼다.
 */
export async function POST(request: NextRequest) {
  if (!(await validateApiKey(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let text = "";
  try {
    text = extractCardWebhookText({
      contentType: request.headers.get("content-type") ?? "",
      bodyRaw: await request.text(),
    });
  } catch {
    return NextResponse.json({ error: "본문을 읽지 못했습니다" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "문자 내용이 비어 있습니다. 본문에 문자 원문을 넣어 주세요." }, { status: 400 });
  }

  const parsed = parseCardSms(text);
  if (!parsed.shouldRecord) {
    return NextResponse.json({ success: true, skipped: true, reason: parsed.skipReason });
  }

  const supabase = createAdminClient();
  try {
    const approvedAt = parsed.approvedAt.toISOString();
    const dedupeKey = [
      "sms",
      parsed.last4 ?? "-",
      approvedAt.slice(0, 16),
      parsed.amount,
      parsed.foreignAmount ?? "",
      parsed.merchant ?? "",
    ].join("|");

    const { data: existing } = await supabase
      .from("card_transactions")
      .select(CARD_TX_SELECT)
      .eq("dedupe_key", dedupeKey)
      .maybeSingle();
    if (existing) return NextResponse.json({ success: true, duplicate: true, data: existing });

    const cardId = await findActiveCardId(supabase, parsed.last4);
    const { data, error } = await supabase
      .from("card_transactions")
      .insert({
        card_id: cardId,
        card_last4: parsed.last4,
        issuer: parsed.issuer,
        amount: parsed.amount,
        currency: parsed.currency,
        foreign_amount: parsed.foreignAmount,
        merchant: parsed.merchant,
        approved_at: approvedAt,
        is_cancellation: parsed.isCancellation,
        status: parsed.isCancellation ? "ignored" : "pending",
        description: parsed.isCancellation ? "승인 취소" : null,
        raw_text: text,
        parse_status: parsed.status,
        source: "webhook",
        dedupe_key: dedupeKey,
      })
      .select(CARD_TX_SELECT)
      .single();

    if (error) {
      // 거의 같은 순간 같은 문자가 두 번 오면 유일 키에 걸린다. 이미 들어간 줄을 돌려준다.
      if (error.code === "23505") {
        const { data: dup } = await supabase.from("card_transactions").select(CARD_TX_SELECT).eq("dedupe_key", dedupeKey).maybeSingle();
        return NextResponse.json({ success: true, duplicate: true, data: dup });
      }
      throw new Error(error.message);
    }

    if (parsed.isCancellation) await markOriginalCancelled(supabase, data);

    logInfo("CARD_SMS_WEBHOOK", `카드 문자 수신: ${parsed.merchant ?? "가맹점 미확인"} ${parsed.amount}원`, {
      resource: "card_transaction",
      resource_id: data.id,
      details: { parse_status: parsed.status, card_matched: Boolean(cardId) },
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    const message = publicErrorMessage(error, "서버 오류가 발생했습니다.");
    logError("CARD_SMS_WEBHOOK_ERROR", `카드 문자 저장 실패: ${message}`, { details: { message } });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** 취소 문자와 금액·카드·가맹점이 맞는 최근 30일 승인 건을 찾아 '무시'로 바꾼다. */
async function markOriginalCancelled(
  supabase: ReturnType<typeof createAdminClient>,
  cancellation: { id: string; amount: number; card_last4: string | null; merchant: string | null; approved_at: string },
) {
  const since = new Date(new Date(cancellation.approved_at).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  let query = supabase
    .from("card_transactions")
    .select("id, description")
    .eq("is_cancellation", false)
    .eq("amount", -cancellation.amount)
    .gte("approved_at", since)
    .lte("approved_at", cancellation.approved_at)
    .neq("status", "ignored")
    .order("approved_at", { ascending: false })
    .limit(1);
  if (cancellation.card_last4) query = query.eq("card_last4", cancellation.card_last4);
  if (cancellation.merchant) query = query.eq("merchant", cancellation.merchant);

  const { data } = await query;
  const original = data?.[0];
  if (!original) return;
  await supabase
    .from("card_transactions")
    .update({ status: "ignored", description: original.description ?? "승인 취소됨" })
    .eq("id", original.id);
}
