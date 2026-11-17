import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/app-url";
import { publicErrorMessage } from "@/lib/safe-error";

import { createRouteAuthErrorResponse, forbiddenResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelExpense, resolveActorEmployee } from "@/lib/expense-mutations";

type RouteContext = { params: Promise<{ id: string }> };

function resolveExpenseUrl(request: NextRequest, id: string) {
  // 알림 링크는 서버 설정 주소 기준(Origin 헤더를 믿지 않는다).
  return appUrl(request, `/dashboard/expenses/${encodeURIComponent(id)}`);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const { supabase, user, employee, authUnavailable } = await requireRouteUser();
  if (!user || !employee) return createRouteAuthErrorResponse(authUnavailable);

  // 승인·지급 예정·지급완료된 건의 취소는 관리자·재무만 한다(직원이 승인 건을 취소한 뒤 금액을 고쳐 다시 올리던 문제).
  if (!employee.isAdmin && !employee.is_finance) {
    const { data: current } = await createAdminClient().from("expenses").select("status").eq("id", id).maybeSingle();
    if (current && ["approved", "scheduled", "paid"].includes(current.status as string)) {
      return forbiddenResponse("승인·지급된 매입의 취소는 관리자 또는 재무 담당만 할 수 있습니다.");
    }
  }

  const body = await request.json().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason : null;

  try {
    const { actorId, actorName } = await resolveActorEmployee(supabase, user.id);
    const data = await cancelExpense(id, reason, {
      actorId,
      actorName,
      expenseUrl: resolveExpenseUrl(request, id),
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = publicErrorMessage(error, "지출 취소에 실패했습니다.");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
