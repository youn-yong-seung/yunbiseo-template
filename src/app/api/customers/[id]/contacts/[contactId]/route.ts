import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, NotFound, errorResponse, unauthorized, dbError } from "@/lib/yb-api/refs";
import { pickContactFields } from "../../../_shared";

type RouteContext = { params: Promise<{ id: string; contactId: string }> };

/** 고객 담당자 수정·삭제: PATCH·DELETE /api/customers/<uuid>/contacts/<담당자uuid>. API 키 필수. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id, contactId } = await context.params;
    const fields = pickContactFields(await request.json());
    if ("name" in fields && !fields.name) throw new BadRequest("name cannot be empty");
    if (Object.keys(fields).length === 0) throw new BadRequest("바꿀 필드가 없습니다");

    const { data, error } = await createAdminClient()
      .from("customer_contacts")
      .update(fields)
      .eq("id", contactId)
      .eq("customer_id", id)
      .select("*")
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data) throw new NotFound("Contact not found");
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id, contactId } = await context.params;
    const { data, error } = await createAdminClient()
      .from("customer_contacts")
      .delete()
      .eq("id", contactId)
      .eq("customer_id", id)
      .select("id")
      .maybeSingle();
    if (error) throw dbError(error);
    if (!data) throw new NotFound("Contact not found");
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
