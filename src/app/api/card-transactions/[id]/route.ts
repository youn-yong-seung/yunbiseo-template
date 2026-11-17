import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, errorResponse, unauthorized } from "@/lib/yb-api/refs";
import { pickCardTxFields, selectCardTx } from "../_shared";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 카드내역 하나: GET·PATCH·DELETE /api/card-transactions/<uuid>. API 키 필수.
 * 적요 적기: PATCH { description: "고객 미팅 커피 3잔" } (yb card update <id> --description ...)
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id } = await context.params;
    return NextResponse.json({ success: true, data: await selectCardTx(createAdminClient(), id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id } = await context.params;
    const body = await request.json();
    const supabase = createAdminClient();
    await selectCardTx(supabase, id);

    const fields = await pickCardTxFields(supabase, body);
    if (Object.keys(fields).length === 0) throw new BadRequest("바꿀 필드가 없습니다");

    const { error } = await supabase.from("card_transactions").update(fields).eq("id", id);
    if (error) throw new BadRequest(error.message);

    const data = await selectCardTx(supabase, id);
    logInfo("UPDATE_CARD_TRANSACTION", `카드내역 수정: ${data.merchant ?? "-"}`, {
      resource: "card_transaction",
      resource_id: id,
      details: { fields: Object.keys(fields) },
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id } = await context.params;
    const supabase = createAdminClient();
    const current = await selectCardTx(supabase, id);
    const { error } = await supabase.from("card_transactions").delete().eq("id", id);
    if (error) throw new BadRequest(error.message);
    logInfo("DELETE_CARD_TRANSACTION", `카드내역 삭제: ${current.merchant ?? "-"} ${current.amount}원`, {
      resource: "card_transaction",
      resource_id: id,
    });
    return NextResponse.json({ success: true, id });
  } catch (error) {
    return errorResponse(error);
  }
}
