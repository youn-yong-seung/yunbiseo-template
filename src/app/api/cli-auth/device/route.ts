import { NextRequest, NextResponse } from "next/server";

import { CHALLENGE_RE, REQUEST_TTL_SECONDS, generateUserCode, hashUserCode } from "@/lib/cli-auth";
import { clientIp } from "@/lib/client-ip";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { UUID_RE } from "@/lib/yb-api/refs";

/**
 * yb login 0단계(디바이스 플로우): yb 가 로그인 요청을 등록하고 확인 코드를 받는다.
 * POST { code_challenge, hostname } → { request_id, user_code, expires_in }   (로그인 불필요, IP 별 5분 10번·전체 100번)
 *  - 확인 코드는 응답으로만 주고 DB 에는 해시만 저장한다. yb 가 터미널에 보여 주고, 사람이 승인 화면에 직접 입력한다.
 *
 * GET ?request=<id> → 승인 화면에 보여 줄 정보(요청한 컴퓨터 이름·요청 시각·발급될 키 이름·내 이름). 로그인 필요.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const challenge = typeof body?.code_challenge === "string" ? body.code_challenge.trim() : "";
  if (!CHALLENGE_RE.test(challenge)) {
    return NextResponse.json({ error: "잘못된 요청입니다. yb 를 최신으로 받아 다시 실행해 주세요." }, { status: 400 });
  }
  const hostname = (typeof body?.hostname === "string" ? body.hostname : "").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40) || "unknown";

  const admin = createAdminClient();
  // 속도 제한은 접속 IP 별로 센다(IP+이 기능 5분 10번). IP 를 모르면(프록시 설정 전) null 로 보내
  // 'IP 모름' 칸을 더 느슨하게(5분 30번) 센다. 어느 경우든 이 기능 전체는 5분 100번까지.
  const ip = clientIp(request.headers);
  const { data: rateOk } = await admin.rpc("check_login_rate", {
    p_ip: ip,
    p_login_key: "cli-device",
  });
  if (rateOk === false) {
    return NextResponse.json({ error: "요청이 너무 많습니다. 5분 뒤 다시 시도해 주세요." }, { status: 429 });
  }

  await admin.from("cli_auth_requests").delete().lt("expires_at", new Date(Date.now() - 86400_000).toISOString());

  const userCode = generateUserCode();
  const { data, error } = await admin
    .from("cli_auth_requests")
    .insert({
      code_challenge: challenge,
      user_code_hash: hashUserCode(userCode),
      hostname,
      expires_at: new Date(Date.now() + REQUEST_TTL_SECONDS * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: "로그인 요청을 만들지 못했습니다." }, { status: 500 });
  }

  return NextResponse.json(
    { request_id: data.id, user_code: userCode, expires_in: REQUEST_TTL_SECONDS },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function GET(request: NextRequest) {
  const { user, employee, authUnavailable } = await requireRouteUser();
  if (!user || !employee) return createRouteAuthErrorResponse(authUnavailable);

  const id = request.nextUrl.searchParams.get("request") ?? "";
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "요청을 찾을 수 없습니다." }, { status: 404 });

  const { data } = await createAdminClient()
    .from("cli_auth_requests")
    .select("id, hostname, created_at, expires_at, employee_id, consumed_at")
    .eq("id", id)
    .maybeSingle();
  if (!data || data.employee_id || data.consumed_at || new Date(data.expires_at).getTime() < Date.now()) {
    return NextResponse.json({ error: "만료됐거나 이미 처리된 요청입니다. 터미널에서 yb login 을 다시 실행해 주세요." }, { status: 404 });
  }

  return NextResponse.json({
    hostname: data.hostname,
    requested_at: data.created_at,
    expires_at: data.expires_at,
    key_name: `yb-cli ${data.hostname}`,
    employee_name: employee.name,
  });
}
