import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import { issueApiKey } from "@/lib/api-key-issue";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * yb CLI 브라우저 로그인 2단계: 1회용 코드를 개인 API 키로 교환한다.
 * 인증 없음 — 코드 자체가 자격증명이다. 실패는 모두 401 로 통일한다.
 * 코드는 원자적으로 소비한다(consumed_at IS NULL 인 행만 갱신).
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code) return unauthorized();

  const hostname = sanitizeHostname(
    typeof body?.hostname === "string" ? body.hostname : ""
  );

  const codeHash = createHash("sha256").update(code).digest("hex");
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // 원자적 소비: 미소비·미만료 행만 consumed_at 을 채우고 그 행을 돌려받는다.
  const { data: consumed, error: consumeError } = await admin
    .from("cli_auth_requests")
    .update({ consumed_at: nowIso })
    .eq("code_hash", codeHash)
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .select("employee_name")
    .maybeSingle();

  if (consumeError || !consumed) return unauthorized();

  const employeeName = consumed.employee_name as string;
  const keyName = `yb-cli ${hostname}`.trim();

  try {
    const issued = await issueApiKey(admin, {
      name: keyName,
      createdBy: employeeName,
    });
    // 원문 키는 로그로 남기지 않는다.
    return NextResponse.json({
      raw_key: issued.raw_key,
      name: issued.name,
      created_by: issued.created_by,
      key_prefix: issued.key_prefix,
    });
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
