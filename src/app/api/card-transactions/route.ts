import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, errorResponse, parseDate, parseLimit, unauthorized, dbError } from "@/lib/yb-api/refs";
import { CARD_TX_SELECT, kstDayEnd, kstDayStart, pickCardTxFields } from "./_shared";

/**
 * 법인카드 사용내역 외부 API (yb card). API 키 필수.
 *
 * GET  /api/card-transactions?from=2026-11-01&to=2026-11-30&last4=1234&status=pending
 *        &missing-description=true&q=가맹점·적요&limit=50
 * POST /api/card-transactions  { amount, merchant?, approved_at?, card_last4?, description?, status? }
 *      문자 연동이 빠뜨린 건을 손으로 넣을 때 쓴다. 문자는 /api/card-transactions/webhook 으로 받는다.
 */
export async function GET(request: NextRequest) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const params = request.nextUrl.searchParams;
    const supabase = createAdminClient();

    let query = supabase.from("card_transactions").select(CARD_TX_SELECT);

    const from = parseDate(params.get("from"), "from");
    const to = parseDate(params.get("to"), "to");
    if (from) query = query.gte("approved_at", kstDayStart(from));
    if (to) query = query.lte("approved_at", kstDayEnd(to));

    const last4 = params.get("last4")?.trim();
    if (last4) query = query.eq("card_last4", last4);

    const statuses = (params.get("status") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    if (statuses.length === 1) query = query.eq("status", statuses[0]);
    if (statuses.length > 1) query = query.in("status", statuses);

    // 적요 안 적은 것만: 무시 처리한 건과 취소 건은 뺀다.
    if (["true", "1", "yes"].includes((params.get("missing-description") ?? params.get("missing_description") ?? "").toLowerCase())) {
      query = query.is("description", null).neq("status", "ignored").eq("is_cancellation", false);
    }
    if (["true", "1", "yes"].includes((params.get("missing-receipt") ?? params.get("missing_receipt") ?? "").toLowerCase())) {
      query = query.is("receipt_url", null).neq("status", "ignored");
    }

    const q = params.get("q")?.trim();
    if (q) {
      const like = `%${q.replace(/[,()]/g, " ")}%`;
      query = query.or(`merchant.ilike.${like},description.ilike.${like}`);
    }

    const { data, error } = await query
      .order("approved_at", { ascending: false })
      .limit(parseLimit(params.get("limit"), 50, 500));
    if (error) throw dbError(error);
    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const body = await request.json();
    if (body.amount === undefined || body.amount === null || body.amount === "") {
      throw new BadRequest("amount is required");
    }
    const supabase = createAdminClient();
    const fields = await pickCardTxFields(supabase, body);
    if (!fields.approved_at) fields.approved_at = new Date().toISOString();

    const { data, error } = await supabase
      .from("card_transactions")
      .insert({ ...fields, source: "manual", is_cancellation: (fields.amount as number) < 0 })
      .select(CARD_TX_SELECT)
      .single();
    if (error) throw dbError(error);

    logInfo("CREATE_CARD_TRANSACTION", `카드내역 수기 등록: ${data.merchant ?? "-"} ${data.amount}원`, {
      resource: "card_transaction",
      resource_id: data.id,
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
