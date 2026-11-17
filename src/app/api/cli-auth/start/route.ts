import { createHash, randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const CODE_TTL_SECONDS = 600; // 10분
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * yb CLI 브라우저 로그인 1단계: 로그인한 직원이 1회용 인증 코드를 발급받는다.
 * - 세션 필수(활성 직원만). 코드는 그 직원 id 에 묶인다.
 * - 원문 코드는 응답으로만 돌려주고 DB 에는 sha256 해시만 저장한다.
 * - CLI 가 code_challenge(PKCE, S256)를 보냈으면 같이 저장한다. 교환할 때 원래 verifier 가 있어야 한다.
 */
export async function POST(request: NextRequest) {
  const { user, employee, authUnavailable } = await requireRouteUser();
  if (!user || !employee) return createRouteAuthErrorResponse(authUnavailable);

  const body = await request.json().catch(() => null);
  const challengeRaw = typeof body?.code_challenge === "string" ? body.code_challenge.trim() : "";
  if (challengeRaw && !CHALLENGE_RE.test(challengeRaw)) {
    return NextResponse.json({ error: "잘못된 인증 요청입니다." }, { status: 400 });
  }

  const code = randomBytes(24).toString("hex");
  const codeHash = createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString();

  const admin = createAdminClient();
  const { error } = await admin.from("cli_auth_requests").insert({
    code_hash: codeHash,
    employee_name: employee.name,
    employee_id: employee.id,
    auth_uid: user.id,
    expires_at: expiresAt,
    code_challenge: challengeRaw || null,
  });

  if (error) {
    return NextResponse.json(
      { error: "인증 코드 생성에 실패했습니다." },
      { status: 500 }
    );
  }

  // 원문 코드는 로그로 남기지 않는다.
  return NextResponse.json(
    { code, expires_in: CODE_TTL_SECONDS },
    { headers: { "cache-control": "no-store" } }
  );
}
