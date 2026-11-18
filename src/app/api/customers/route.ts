import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, errorResponse, normalizeText, parseLimit, unauthorized, dbError } from "@/lib/yb-api/refs";
import { CUSTOMER_SELECT, pickCustomerFields } from "./_shared";

/**
 * 고객 외부 API (yb customer). API 키 필수.
 *
 * GET  /api/customers?q=이름&customer_type=법인&limit=20
 * POST /api/customers  { name, customer_type?, contact_phone?, ... , skip_if_exists?: true }
 *      같은 이름이 있으면 새로 만들지 않고 기존 고객을 돌려준다(created:false). 강제로 만들려면 skip_if_exists:false.
 */
export async function GET(request: NextRequest) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const params = request.nextUrl.searchParams;
    const supabase = createAdminClient();

    let query = supabase.from("customers").select(CUSTOMER_SELECT);
    const q = params.get("q")?.trim();
    if (q) {
      const like = `%${q.replace(/[,()]/g, " ")}%`;
      query = query.or(`name.ilike.${like},representative_name.ilike.${like},contact_name.ilike.${like}`);
    }
    const type = params.get("customer_type")?.trim();
    if (type) query = query.eq("customer_type", type);

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(parseLimit(params.get("limit"), 20, 100));
    if (error) throw dbError(error);
    return NextResponse.json({ data: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const body = await request.json();
    const name = normalizeText(body.name);
    if (!name) throw new BadRequest("name is required");

    const supabase = createAdminClient();
    if (body.skip_if_exists !== false) {
      const { data: existing } = await supabase
        .from("customers")
        .select(CUSTOMER_SELECT)
        .eq("name", name)
        .limit(1)
        .maybeSingle();
      if (existing) return NextResponse.json({ data: existing, created: false });
    }

    const { data, error } = await supabase
      .from("customers")
      .insert({ ...pickCustomerFields(body), name })
      .select(CUSTOMER_SELECT)
      .single();
    if (error) throw dbError(error);
    if (!data) throw new BadRequest("고객을 저장하지 못했습니다.");

    logInfo("CREATE_CUSTOMER_API", `외부 API 고객 등록: ${name}`, {
      resource: "customer",
      resource_id: data.id,
    });
    return NextResponse.json({ data, created: true }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
