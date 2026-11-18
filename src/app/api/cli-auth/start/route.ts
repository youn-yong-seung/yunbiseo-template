import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { hashUserCode, normalizeUserCode } from "@/lib/cli-auth";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/yb-api/refs";

/**
 * yb login 승인: 로그인한 직원이 yb 가 등록한 요청(request_id)을 터미널의 확인 코드로 승인한다.
 * POST { request_id, user_code } → { code }  (1회용 교환 코드, 원문은 응답으로만)
 *
 * - 확인 코드가 맞아야 한다(5번 틀리면 그 요청은 못 쓰게 된다). 남이 보낸 주소를 눌러 주는 것만으로는 승인되지 않는다.
 * - 승인한 직원 id 에 묶이고, 교환할 때 yb 가 가진 PKCE verifier 가 있어야 키가 나온다.
 */
export async function POST(request: NextRequest) {
  const { user, employee, authUnavailable } = await requireRouteUser();
  if (!user || !employee) return createRouteAuthErrorResponse(authUnavailable);

  const body = await request.json().catch(() => null);
  const requestId = typeof body?.request_id === "string" ? body.request_id : "";
  const userCode = typeof body?.user_code === "string" ? normalizeUserCode(body.user_code) : "";
  if (!UUID_RE.test(requestId) || userCode.length !== 8) {
    return NextResponse.json({ error: "확인 코드 8자를 정확히 입력해 주세요." }, { status: 400 });
  }

  const admin = createAdminClient();
  // 대조와 실패 횟수 증가를 DB 한 번(행 잠금)으로 한다. 동시에 여러 번 보내도 5번까지만 대조되고,
  // 5번째로 틀리면 그 요청의 확인 코드는 지워진다(cli_auth_check_user_code).
  const { data: verdict, error: checkError } = await admin.rpc("cli_auth_check_user_code", {
    p_request_id: requestId,
    p_code_hash: hashUserCode(userCode),
  });
  if (checkError) {
    console.error("[cli-auth/start]", checkError.message);
    return NextResponse.json({ error: "승인하지 못했습니다. 잠시 뒤 다시 시도해 주세요." }, { status: 500 });
  }
  if (verdict === "mismatch") {
    return NextResponse.json({ error: "확인 코드가 터미널에 보이는 코드와 다릅니다." }, { status: 403 });
  }
  if (verdict !== "ok") {
    return NextResponse.json({ error: "만료됐거나 이미 처리된 요청입니다. 터미널에서 yb login 을 다시 실행해 주세요." }, { status: 410 });
  }
  const row = { id: requestId };

  const code = randomBytes(24).toString("hex");
  const { data: approved, error } = await admin
    .from("cli_auth_requests")
    .update({
      code_hash: createHash("sha256").update(code).digest("hex"),
      employee_id: employee.id,
      employee_name: employee.name,
      auth_uid: user.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .is("employee_id", null)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();

  if (error || !approved) {
    return NextResponse.json({ error: "승인하지 못했습니다. yb login 을 다시 실행해 주세요." }, { status: 409 });
  }

  // 원문 코드는 로그로 남기지 않는다.
  return NextResponse.json({ code }, { headers: { "cache-control": "no-store" } });
}
