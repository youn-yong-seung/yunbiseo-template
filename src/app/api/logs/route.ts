import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapePostgrestLike } from "@/lib/utils";
import { createRouteAuthErrorResponse, requireRouteAdmin, requireRouteUser } from "@/lib/route-auth";

export async function GET(request: NextRequest) {
  try {
    // 활동 로그(로그인 실패·IP 등)는 관리자만 본다.
    const auth = await requireRouteAdmin();
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(request.url);
    const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10) || 0);
    const limit = Math.min(Math.max(1, parseInt(searchParams.get("limit") || "50", 10) || 50), 100);
    const level = searchParams.get("level");
    const search = searchParams.get("search")?.replace(/[,()]/g, " ").slice(0, 100);

    const admin = createAdminClient();
    let query = admin
      .from("app_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (level && (level === "INFO" || level === "ERROR")) {
      query = query.eq("level", level);
    }

    if (search) {
      query = query.or(
        `message.ilike.%${escapePostgrestLike(search)}%,action.ilike.%${escapePostgrestLike(search)}%,actor_name.ilike.%${escapePostgrestLike(search)}%`
      );
    }

    const { data, count, error } = await query;

    if (error) {
      return NextResponse.json({ error: publicErrorMessage(error) }, { status: 500 });
    }

    return NextResponse.json({ data: data ?? [], total: count ?? 0 });
  } catch (error) {
    const message = publicErrorMessage(error, "서버 오류가 발생했습니다.");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, employee, authUnavailable } = await requireRouteUser();
    if (!user || !employee) {
      return createRouteAuthErrorResponse(authUnavailable);
    }

    const body = await request.json();
    const { action, message, level, resource, resource_id, details } = body;

    if (typeof action !== "string" || typeof message !== "string" || !action || !message) {
      return NextResponse.json(
        { error: "action and message are required" },
        { status: 400 }
      );
    }

    const logLevel = level === "ERROR" ? "ERROR" : "INFO";
    const forwarded = request.headers.get("x-forwarded-for")?.split(",").map((v) => v.trim()).filter(Boolean) ?? [];
    const ip =
      (request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-real-ip"))?.split(",")[0]?.trim().slice(0, 64) ??
      forwarded[forwarded.length - 1]?.slice(0, 64) ??
      null;

    let actorId: string | null = null;
    let actorName: string | null = null;

    const admin = createAdminClient();

    // 기록자는 요청 본문이 아니라 로그인한 직원으로 정한다(남의 이름으로 로그를 남기지 못하게).
    actorId = employee.id;
    actorName = employee.name;
    const { error } = await admin.from("app_logs").insert({
      level: logLevel,
      action: action.slice(0, 100),
      message: message.slice(0, 1000),
      resource: typeof resource === "string" ? resource.slice(0, 100) : null,
      resource_id: typeof resource_id === "string" ? resource_id.slice(0, 100) : null,
      actor_id: actorId,
      actor_name: actorName,
      ip_address: ip,
      details: details && JSON.stringify(details).length <= 5000 ? details : null,
    });

    if (error) {
      return NextResponse.json({ error: publicErrorMessage(error) }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    const message = publicErrorMessage(error, "서버 오류가 발생했습니다.");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
