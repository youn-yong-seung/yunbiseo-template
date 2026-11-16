import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, NotFound, errorResponse, unauthorized } from "@/lib/yb-api/refs";
import { CUSTOMER_SELECT, pickCustomerFields } from "../_shared";

type RouteContext = { params: Promise<{ id: string }> };

/** 고객 하나: GET·PATCH /api/customers/<uuid>. API 키 필수. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id } = await context.params;
    const { data, error } = await createAdminClient()
      .from("customers")
      .select(CUSTOMER_SELECT)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new BadRequest(error.message);
    if (!data) throw new NotFound("Customer not found");
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id } = await context.params;
    const fields = pickCustomerFields(await request.json());
    if ("name" in fields && !fields.name) throw new BadRequest("name cannot be empty");
    if (Object.keys(fields).length === 0) throw new BadRequest("바꿀 필드가 없습니다");

    const { data, error } = await createAdminClient()
      .from("customers")
      .update(fields)
      .eq("id", id)
      .select(CUSTOMER_SELECT)
      .maybeSingle();
    if (error) throw new BadRequest(error.message);
    if (!data) throw new NotFound("Customer not found");

    logInfo("UPDATE_CUSTOMER_API", `외부 API 고객 수정: ${data.name}`, {
      resource: "customer",
      resource_id: id,
      details: { fields: Object.keys(fields) },
    });
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}
