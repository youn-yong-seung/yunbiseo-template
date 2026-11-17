import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateApiKeyRecord } from "@/lib/api-key";
import { verifyCronSecret } from "@/lib/route-auth";
import { logInfo } from "@/lib/logger";

/**
 * 매일 1회 호출 가정 (Vercel Cron 또는 외부 스케줄러).
 * 오늘 날짜의 day_of_month와 일치하는 active 템플릿 중
 * last_generated_month != 'YYYY-MM' 인 것들을 expenses에 자동 등록한다.
 */
export async function POST(request: NextRequest) {
  return handle(request);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest) {
  try {
    // Vercel Cron(CRON_SECRET) 또는 관리자 API 키만 실행할 수 있다.
    const cronOk = verifyCronSecret(request);
    const key = cronOk ? null : await validateApiKeyRecord(request);
    const valid = cronOk || Boolean(key?.employee.isAdmin);
    if (!valid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createAdminClient();
    const now = new Date();
    const today = now.getDate();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const todayIso = now.toISOString().slice(0, 10);

    const { data: templates, error: fetchErr } = await supabase
      .from("recurring_expenses")
      .select("*")
      .eq("is_active", true)
      .eq("day_of_month", today);

    if (fetchErr) {
      return NextResponse.json({ error: publicErrorMessage(fetchErr) }, { status: 500 });
    }

    const eligible = (templates ?? []).filter((tpl) => {
      if (tpl.last_generated_month === monthKey) return false;
      if (tpl.start_date && tpl.start_date > todayIso) return false;
      if (tpl.end_date && tpl.end_date < todayIso) return false;
      return true;
    });

    const results: Array<{ template_id: string; expense_id?: string; error?: string }> = [];

    for (const tpl of eligible) {
      const amount = tpl.amount as number;
      const supply = tpl.vat_included ? Math.round(amount / 1.1) : amount;
      const vat = tpl.vat_included ? amount - supply : 0;

      const { data: expense, error: insertErr } = await supabase
        .from("expenses")
        .insert({
          title: tpl.title,
          type_id: tpl.type_id,
          vendor_name: tpl.vendor_name,
          vendor_id: tpl.vendor_id,
          total_amount: amount,
          supply_amount: supply,
          vat_amount: vat,
          vat_included: tpl.vat_included,
          purchase_date: todayIso,
          payment_date: null,
          purchase_tax_invoice_received: false,
          purchase_tax_invoice_not_required: false,
          memo: tpl.memo,
          source: "recurring",
          recurring_expense_id: tpl.id,
        })
        .select("id")
        .single();

      if (insertErr) {
        console.error("[recurring-expenses]", insertErr.message);
        results.push({ template_id: tpl.id, error: "매입을 만들지 못했습니다." });
        continue;
      }

      await supabase
        .from("recurring_expenses")
        .update({ last_generated_month: monthKey })
        .eq("id", tpl.id);

      logInfo(
        "GENERATE_RECURRING_EXPENSE",
        `반복 지출 자동 생성: ${tpl.title} ${amount.toLocaleString()}원 (${monthKey})`,
        { resource: "expense", resource_id: expense.id }
      );
      results.push({ template_id: tpl.id, expense_id: expense.id });
    }

    return NextResponse.json({
      month: monthKey,
      day: today,
      total_templates_today: templates?.length ?? 0,
      generated: results.filter((r) => !r.error).length,
      skipped: (templates?.length ?? 0) - eligible.length,
      errors: results.filter((r) => r.error),
      results,
    });
  } catch (error) {
    const message = publicErrorMessage(error, "서버 오류가 발생했습니다.");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
