import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/app-url";
import { publicErrorMessage } from "@/lib/safe-error";

import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { resolveActorEmployee, submitExpense } from "@/lib/expense-mutations";

type RouteContext = { params: Promise<{ id: string }> };

function resolveExpenseUrl(request: NextRequest, id: string) {
  // 알림 링크는 서버 설정 주소 기준(Origin 헤더를 믿지 않는다).
  return appUrl(request, `/dashboard/expenses/${encodeURIComponent(id)}`);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const { supabase, user, authUnavailable } = await requireRouteUser();
  if (!user) return createRouteAuthErrorResponse(authUnavailable);

  try {
    const { actorId, actorName } = await resolveActorEmployee(supabase, user.id);
    const data = await submitExpense(id, {
      actorId,
      actorName,
      expenseUrl: resolveExpenseUrl(request, id),
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = publicErrorMessage(error, "지출 결의 제출에 실패했습니다.");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
