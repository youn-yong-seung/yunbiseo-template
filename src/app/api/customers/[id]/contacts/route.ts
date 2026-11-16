import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, NotFound, errorResponse, unauthorized } from "@/lib/yb-api/refs";
import { pickContactFields } from "../../_shared";

type RouteContext = { params: Promise<{ id: string }> };

/** 고객 담당자 목록·추가: GET·POST /api/customers/<uuid>/contacts. API 키 필수. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id } = await context.params;
    const { data, error } = await createAdminClient()
      .from("customer_contacts")
      .select("*")
      .eq("customer_id", id)
      .order("created_at", { ascending: true });
    if (error) throw new BadRequest(error.message);
    return NextResponse.json({ data: data ?? [] });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id } = await context.params;
    const fields = pickContactFields(await request.json());
    if (!fields.name) throw new BadRequest("name is required");

    const supabase = createAdminClient();
    const { data: customer } = await supabase.from("customers").select("id").eq("id", id).maybeSingle();
    if (!customer) throw new NotFound("Customer not found");

    const { data, error } = await supabase
      .from("customer_contacts")
      .insert({ ...fields, customer_id: id })
      .select("*")
      .single();
    if (error) throw new BadRequest(error.message);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
