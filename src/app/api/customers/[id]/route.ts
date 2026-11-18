import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { canManageFinance, forbiddenResponse } from "@/lib/route-auth";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { BadRequest, NotFound, errorResponse, unauthorized, dbError } from "@/lib/yb-api/refs";
import { CUSTOMER_SELECT, pickCustomerFields } from "../_shared";

const BANK_FIELDS = ["bank_name", "account_number", "account_holder"] as const;

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
    if (error) throw dbError(error);
    if (!data) throw new NotFound("Customer not found");
    return NextResponse.json({ data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const apiKey = await validateApiKeyRecord(request);
    if (!apiKey) return unauthorized();
    const { id } = await context.params;
    const fields = pickCustomerFields(await request.json());
    // 이미 있는 거래처의 계좌(돈 받을 곳)를 바꾸는 건 관리자·재무만(DB 트리거와 같은 규칙).
    const bankTouched = BANK_FIELDS.some((key) => key in fields);
    if (bankTouched && !canManageFinance(apiKey.employee)) {
      const { data: current } = await createAdminClient()
        .from("customers")
        .select("bank_name, account_number, account_holder")
        .eq("id", id)
        .maybeSingle();
      const changed = current && BANK_FIELDS.some((key) => key in fields && (fields[key] ?? null) !== (current[key] ?? null));
      if (changed) {
        return forbiddenResponse("거래처 계좌(은행·계좌번호·예금주)는 관리자 또는 재무 담당만 바꿀 수 있습니다.");
      }
      for (const key of BANK_FIELDS) delete fields[key];
    }
    if ("name" in fields && !fields.name) throw new BadRequest("name cannot be empty");
    if (Object.keys(fields).length === 0) throw new BadRequest("바꿀 필드가 없습니다");

    const { data, error } = await createAdminClient()
      .from("customers")
      .update(fields)
      .eq("id", id)
      .select(CUSTOMER_SELECT)
      .maybeSingle();
    if (error) throw dbError(error);
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
