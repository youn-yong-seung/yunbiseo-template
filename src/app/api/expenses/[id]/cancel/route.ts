import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/app-url";
import { publicErrorMessage } from "@/lib/safe-error";

import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { NOT_OWNER_MESSAGE, STATUS_CHANGED_MESSAGE, cancelExpense, resolveActorEmployee } from "@/lib/expense-mutations";

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
  // 확인과 취소를 한 번의 조건부 update 로 한다(cancelExpense 의 allowedFrom + 상태 조건).
  const privileged = employee.isAdmin || employee.is_finance;
  const body = await request.json().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason : null;

  try {
    const { actorId, actorName } = await resolveActorEmployee(supabase, user.id);
    const data = await cancelExpense(id, reason, {
      actorId,
      actorName,
      expenseUrl: resolveExpenseUrl(request, id),
      // 관리자·재무가 아니면 본인이 결재 요청한 건(또는 요청 전 작성중 건)만 취소한다.
      ...(privileged ? {} : { ownerEmployeeId: employee.id }),
    }, privileged ? undefined : (["draft", "requested", "rejected"] as const));
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = publicErrorMessage(error, "지출 취소에 실패했습니다.");
    const status =
      message.startsWith("승인·지급된 매입의 취소는") || message === NOT_OWNER_MESSAGE
        ? 403
        : message === STATUS_CHANGED_MESSAGE
          ? 409
          : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
