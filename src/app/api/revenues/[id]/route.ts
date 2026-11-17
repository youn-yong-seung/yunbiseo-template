import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, NotFound, UUID_RE, errorResponse, unauthorized, dbError } from "@/lib/yb-api/refs";
import { REVENUE_SELECT, pickRevenueFields, resolveAmounts } from "../_shared";

type RouteContext = { params: Promise<{ id: string }> };

async function selectRevenue(supabase: ReturnType<typeof createAdminClient>, id: string) {
  if (!UUID_RE.test(id)) throw new NotFound("Revenue not found");
  const { data, error } = await supabase.from("revenues").select(REVENUE_SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFound("Revenue not found");
  return data;
}

/** 매출 하나: GET·PATCH /api/revenues/<uuid>. API 키 필수. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id } = await context.params;
    return NextResponse.json({ success: true, data: await selectRevenue(createAdminClient(), id) });
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
    const current = await selectRevenue(supabase, id);

    const fields = await pickRevenueFields(supabase, body);
    const amounts = resolveAmounts(body, current);
    if (amounts) Object.assign(fields, amounts);
    if (Object.keys(fields).length === 0) throw new BadRequest("바꿀 필드가 없습니다");

    // 볼타로 발행 중이거나 발행된 건은 손으로 발행 여부를 바꾸지 않는다(국세청 기록과 어긋난다).
    const boltaTracked = current.tax_invoice_issue_status === "issuing" || current.tax_invoice_issue_status === "issued";
    if (boltaTracked && ("is_tax_invoice_issued" in fields || amounts)) {
      throw new BadRequest("볼타로 발행(중)인 매출은 금액이나 발행 여부를 바꿀 수 없습니다");
    }

    const { error } = await supabase.from("revenues").update(fields).eq("id", id);
    if (error) throw dbError(error);

    const data = await selectRevenue(supabase, id);
    logInfo("UPDATE_REVENUE_API", `외부 API 매출 수정: ${data.title}`, {
      resource: "revenue",
      resource_id: id,
      details: { fields: Object.keys(fields) },
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return errorResponse(error);
  }
}
