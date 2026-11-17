import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { issueApiKey } from "@/lib/api-key-issue";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * yb CLI 브라우저 로그인 2단계: 1회용 코드를 개인 API 키로 교환한다.
 * 세션 없음 — 코드 자체가 자격증명이다. 실패는 모두 401 로 통일한다.
 *
 * - 코드는 원자적으로 소비한다(consumed_at IS NULL 이고 만료 전인 행만 갱신). 두 번 쓸 수 없다.
 * - 1단계에서 code_challenge 를 저장했으면 code_verifier 의 sha256(base64url)이 같아야 한다(PKCE).
 *   verifier 가 틀려도 코드는 이미 소비돼 다시 쓸 수 없다(가로챈 코드로 재시도 불가).
 * - 발급 시점에 직원이 비활성이거나 지워졌으면 키를 만들지 않는다.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code || code.length > 200) return unauthorized();
  const verifier = typeof body?.code_verifier === "string" ? body.code_verifier.trim() : "";

  const hostname = sanitizeHostname(
    typeof body?.hostname === "string" ? body.hostname : ""
  );

  const codeHash = createHash("sha256").update(code).digest("hex");
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data: consumed, error: consumeError } = await admin
    .from("cli_auth_requests")
    .update({ consumed_at: nowIso })
    .eq("code_hash", codeHash)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .select("employee_id, code_challenge")
    .maybeSingle();

  if (consumeError || !consumed || !consumed.employee_id) return unauthorized();

  if (consumed.code_challenge) {
    if (!verifier) return unauthorized();
    const expected = createHash("sha256").update(verifier).digest("base64url");
    const a = Buffer.from(expected);
    const b = Buffer.from(String(consumed.code_challenge));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return unauthorized();
  }

  const { data: employee } = await admin
    .from("employees")
    .select("id, name, is_active")
    .eq("id", consumed.employee_id)
    .maybeSingle();
  if (!employee || employee.is_active !== true) return unauthorized();

  try {
    const issued = await issueApiKey(admin, {
      name: `yb-cli ${hostname}`.trim(),
      employeeId: employee.id as string,
      employeeName: employee.name as string,
    });
    // 원문 키는 로그로 남기지 않는다.
    return NextResponse.json(
      {
        raw_key: issued.raw_key,
        name: issued.name,
        created_by: issued.created_by,
        employee_id: issued.employee_id,
        key_prefix: issued.key_prefix,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    return unauthorized();
  }
}

function unauthorized() {
  return NextResponse.json(
    { error: "invalid_or_expired_code" },
    { status: 401 }
  );
}

function sanitizeHostname(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40);
  return cleaned || "unknown";
}
