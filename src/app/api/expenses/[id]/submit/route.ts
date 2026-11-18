import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/app-url";
import { publicErrorMessage } from "@/lib/safe-error";

import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { NOT_OWNER_MESSAGE, STATUS_CHANGED_MESSAGE, resolveActorEmployee, submitExpense } from "@/lib/expense-mutations";

type RouteContext = { params: Promise<{ id: string }> };

function resolveExpenseUrl(request: NextRequest, id: string) {
  // 알림 링크는 서버 설정 주소 기준(Origin 헤더를 믿지 않는다).
  return appUrl(request, `/dashboard/expenses/${encodeURIComponent(id)}`);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const { supabase, user, employee, authUnavailable } = await requireRouteUser();
  if (!user || !employee) return createRouteAuthErrorResponse(authUnavailable);
  const privileged = employee.isAdmin || employee.is_finance;

  try {
    const { actorId, actorName } = await resolveActorEmployee(supabase, user.id);
    const data = await submitExpense(id, {
      actorId,
      actorName,
      expenseUrl: resolveExpenseUrl(request, id),
      // 관리자·재무가 아니면 다른 직원이 결재 요청했던 건(반려 등)을 대신 다시 올리지 못한다.
      ...(privileged ? {} : { ownerEmployeeId: employee.id }),
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = publicErrorMessage(error, "지출 결의 제출에 실패했습니다.");
    const status = message === NOT_OWNER_MESSAGE ? 403 : message === STATUS_CHANGED_MESSAGE ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
