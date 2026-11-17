"use client";

import { useEffect, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * 지금 로그인한 직원이 매입을 승인·지급 처리할 수 있는지(관리자 또는 재무 담당).
 * DB 트리거(guard_expense_write)가 최종으로 막고, 화면은 이 값으로 "지급완료" 상태를 쓸지 정한다.
 */
export function useCanSettleExpenses() {
  const [canSettle, setCanSettle] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    void supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      const { data } = await supabase
        .from("employees")
        .select("employee_type, is_finance")
        .eq("auth_uid", user.id)
        .maybeSingle();
      if (!cancelled) setCanSettle(data?.employee_type === "관리자" || data?.is_finance === true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return canSettle;
}
