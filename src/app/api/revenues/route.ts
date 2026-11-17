import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BadRequest,
  errorResponse,
  parseDate,
  parseLimit,
  resolveProjectRef,
  unauthorized,
} from "@/lib/yb-api/refs";
import { REVENUE_SELECT, parseBoolean, pickRevenueFields, resolveAmounts, todayKst } from "./_shared";

/**
 * 매출 외부 API (yb revenue). API 키 필수.
 *
 * GET  /api/revenues?q=제목&project=26-3&from=2026-11-01&to=2026-11-30&paid=false&tax_invoice=false&limit=50
 * POST /api/revenues  { title, total_amount, supply_amount?, vat_amount?, project_id?(번호 26-3 가능),
 *                       revenue_date?, is_paid?, paid_date?, is_tax_invoice_issued?, tax_invoice_date?,
 *                       tax_invoice_not_required?, memo?, channel?, product_name?, external_order_id? }
 *      합계만 주면 부가세 10% 포함으로 보고 공급가·부가세를 나눈다. 매출일을 안 주면 오늘.
 */
export async function GET(request: NextRequest) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const params = request.nextUrl.searchParams;
    const supabase = createAdminClient();

    let query = supabase.from("revenues").select(REVENUE_SELECT);

    const q = params.get("q")?.trim();
    if (q) {
      const like = `%${q.replace(/[,()]/g, " ")}%`;
      query = query.or(`title.ilike.${like},memo.ilike.${like},product_name.ilike.${like}`);
    }
    const projectRef = params.get("project")?.trim();
    if (projectRef) {
      const projectId = await resolveProjectRef(supabase, projectRef);
      if (!projectId) throw new BadRequest(`project not found: ${projectRef}`);
      query = query.eq("project_id", projectId);
    }
    const from = parseDate(params.get("from"), "from");
    const to = parseDate(params.get("to"), "to");
    if (from) query = query.gte("revenue_date", from);
    if (to) query = query.lte("revenue_date", to);

    const paid = parseBoolean(params.get("paid"));
    if (paid !== null) query = query.eq("is_paid", paid);

    // tax_invoice=false: 아직 세금계산서를 안 끊은(발행 대상인) 매출만.
    const taxInvoice = parseBoolean(params.get("tax_invoice"));
    if (taxInvoice === true) query = query.eq("is_tax_invoice_issued", true);
    if (taxInvoice === false) {
      query = query.eq("is_tax_invoice_issued", false).eq("tax_invoice_not_required", false);
    }

    const { data, error } = await query
      .order("revenue_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(parseLimit(params.get("limit"), 50, 500));
    if (error) throw new BadRequest(error.message);
    return NextResponse.json({ success: true, data: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const body = await request.json();
    if (typeof body.title !== "string" || !body.title.trim()) throw new BadRequest("title is required");
    if (body.total_amount === undefined || body.total_amount === null || body.total_amount === "") {
      throw new BadRequest("total_amount is required");
    }

    const supabase = createAdminClient();
    const fields = await pickRevenueFields(supabase, body);
    const amounts = resolveAmounts(body);
    if (!amounts) throw new BadRequest("total_amount is required");

    // 환불(음수) 매출은 세금계산서 대상이 아니다.
    if (amounts.total_amount < 0) {
      fields.is_tax_invoice_issued = false;
      fields.tax_invoice_date = null;
      fields.tax_invoice_not_required = true;
    }
    // 매출일을 안 주면 오늘로 둔다(웹 목록·월별 집계에서 '날짜미정'으로 빠지지 않게).
    if (!fields.revenue_date) fields.revenue_date = todayKst();
    if (!fields.channel) {
      fields.product_name = null;
      fields.external_order_id = null;
    }

    const { data, error } = await supabase
      .from("revenues")
      .insert({ ...fields, ...amounts })
      .select(REVENUE_SELECT)
      .single();
    if (error) throw new BadRequest(error.message);

    logInfo("CREATE_REVENUE", `매출 등록: ${data.title}`, {
      resource: "revenue",
      resource_id: data.id,
      details: { total_amount: amounts.total_amount },
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
