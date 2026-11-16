import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";

import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const CODE_TTL_SECONDS = 600; // 10분

/**
 * yb CLI 브라우저 로그인 1단계: 로그인한 직원이 1회용 인증 코드를 발급받는다.
 * 세션 필수. 원문 코드는 응답으로만 반환하고 DB 에는 sha256 해시만 저장한다.
 */
export async function POST() {
  const { supabase, user, authUnavailable } = await requireRouteUser();
  if (!user) return createRouteAuthErrorResponse(authUnavailable);

  const { data: employee } = await supabase
    .from("employees")
    .select("name")
    .eq("auth_uid", user.id)
    .maybeSingle();

  const employeeName = (employee?.name as string | null)?.trim();
  if (!employeeName) {
    return NextResponse.json(
      { error: "직원 정보를 찾을 수 없습니다." },
      { status: 403 }
    );
  }

  const code = randomBytes(24).toString("hex");
  const codeHash = createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();

  const admin = createAdminClient();
  const { error } = await admin.from("cli_auth_requests").insert({
    code_hash: codeHash,
    employee_name: employeeName,
    auth_uid: user.id,
    expires_at: expiresAt,
  });

  if (error) {
    return NextResponse.json(
      { error: "인증 코드 생성에 실패했습니다." },
      { status: 500 }
    );
  }

  // 원문 코드는 로그로 남기지 않는다.
  return NextResponse.json({ code, expires_in: CODE_TTL_SECONDS });
}
