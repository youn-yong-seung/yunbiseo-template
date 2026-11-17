import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";

import { createRouteAuthErrorResponse, forbiddenResponse, requireRouteUser } from "@/lib/route-auth";
import { markExpensePaid, resolveActorEmployee } from "@/lib/expense-mutations";

type RouteContext = { params: Promise<{ id: string }> };

function resolveExpenseUrl(request: NextRequest, id: string) {
  try {
    const origin = request.headers.get("origin") ?? new URL(request.url).origin;
    return `${origin}/dashboard/expenses/${id}`;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const { supabase, user, employee, authUnavailable } = await requireRouteUser();
  if (!user || !employee) return createRouteAuthErrorResponse(authUnavailable);
  // 승인·반려·지급 처리는 관리자 또는 재무 담당만 한다.
  if (!employee.isAdmin && !employee.is_finance) {
    return forbiddenResponse("관리자 또는 재무 담당만 할 수 있습니다.");
  }

  const body = await request.json().catch(() => null);
  const rawDate = body?.payment_date ?? body?.paid_date;
  const paymentDate = typeof rawDate === "string" ? rawDate.trim() : "";
  if (!paymentDate) {
    return NextResponse.json({ error: "payment_date is required" }, { status: 400 });
  }

  try {
    const { actorId, actorName } = await resolveActorEmployee(supabase, user.id);
    const data = await markExpensePaid(id, paymentDate, {
      actorId,
      actorName,
      expenseUrl: resolveExpenseUrl(request, id),
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = publicErrorMessage(error, "매입 지급 완료 처리에 실패했습니다.");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
