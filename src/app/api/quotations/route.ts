import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateApiKey } from "@/lib/api-key";
import { toKstDateString } from "@/lib/date";
import { logInfo } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const isValid = await validateApiKey(request);
    if (!isValid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("quotations")
      .select("*, customers(id, name), projects(id, project_number, name), quotation_items(*)")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: publicErrorMessage(error) }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = publicErrorMessage(error, "서버 오류가 발생했습니다.");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const isValid = await validateApiKey(request);
    if (!isValid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const supabase = createAdminClient();

    // Generate quotation number
    const { data: quotationNumber, error: rpcError } = await supabase.rpc("generate_quotation_number");
    if (rpcError || !quotationNumber) {
      return NextResponse.json(
        { error: "견적번호를 만들지 못했습니다." },
        { status: 500 }
      );
    }

    const recipientName = typeof body.recipient_name === "string" ? body.recipient_name.trim() : "";
    if (!recipientName) {
      return NextResponse.json({ error: "recipient_name is required" }, { status: 400 });
    }

    const payload = {
      quotation_number: quotationNumber,
      quotation_date: body.quotation_date || toKstDateString(),
      valid_until: body.valid_until || null,
      status: body.status || "작성중",
      customer_id: body.customer_id || null,
      recipient_name: recipientName,
      recipient_contact_name: body.recipient_contact_name || null,
      recipient_phone: body.recipient_phone || null,
      recipient_address: body.recipient_address || null,
      supplier_name: body.supplier_name || "",
      supplier_representative: body.supplier_representative || "",
      supplier_business_number: body.supplier_business_number || "",
      supplier_phone: body.supplier_phone || "",
      supplier_manager: body.supplier_manager || "",
      supplier_address: body.supplier_address || null,
      supplier_business_type: body.supplier_business_type || null,
      supplier_business_category: body.supplier_business_category || null,
      supply_total: body.supply_total || 0,
      vat_total: body.vat_total || 0,
      grand_total: body.grand_total || 0,
      payment_terms: body.payment_terms || null,
      delivery_terms: body.delivery_terms || null,
      bank_account: body.bank_account || "",
      memo: body.memo || null,
      project_id: body.project_id || null,
    };

    const { data, error } = await supabase
      .from("quotations")
      .insert(payload)
      .select("id, quotation_number")
      .single();

    if (error) {
      return NextResponse.json({ error: publicErrorMessage(error) }, { status: 400 });
    }

    // Insert items if provided
    if (Array.isArray(body.items) && body.items.length > 0) {
      const itemsPayload = body.items.map((item: Record<string, unknown>, idx: number) => ({
        quotation_id: data.id,
        sort_order: idx,
        item_name: String(item.item_name || ""),
        specification: item.specification || null,
        unit: item.unit || "식",
        quantity: Number(item.quantity) || 1,
        unit_price: Number(item.unit_price) || 0,
        supply_amount: (Number(item.quantity) || 1) * (Number(item.unit_price) || 0),
        remark: item.remark || null,
      }));

      const { error: itemsError } = await supabase.from("quotation_items").insert(itemsPayload);
      if (itemsError) {
        return NextResponse.json({ error: "견적 품목을 저장하지 못했습니다." }, { status: 400 });
      }
    }

    logInfo("CREATE_QUOTATION", `견적 등록: ${data.quotation_number}`, {
      resource: "quotation",
      resource_id: data.id,
    });

    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    const message = publicErrorMessage(error, "서버 오류가 발생했습니다.");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
