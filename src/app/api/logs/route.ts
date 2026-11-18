import { NextRequest, NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapePostgrestLike } from "@/lib/utils";
import { clientIp } from "@/lib/client-ip";
import { createRouteAuthErrorResponse, requireRouteAdmin, requireRouteUser } from "@/lib/route-auth";

/** 브라우저(sendLog)가 남길 수 있는 기록 이름. 화면에 새 기록을 넣으면 여기에도 더한다. */
const CLIENT_LOG_ACTIONS = new Set([
  "LOGIN", "LOGOUT",
  "FOCUS_START", "FOCUS_STOP", "FOCUS_COMPLETE",
  "CREATE_CUSTOMER", "DELETE_CUSTOMER",
  "CREATE_CUSTOMER_NOTE", "UPDATE_CUSTOMER_NOTE", "DELETE_CUSTOMER_NOTE",
  "CREATE_PROJECT", "UPDATE_PROJECT", "DELETE_PROJECT", "BULK_UPDATE_PROJECT",
  "CREATE_PROJECT_NOTE", "UPDATE_PROJECT_NOTE", "DELETE_PROJECT_NOTE",
  "CREATE_TASK", "UPDATE_TASK", "DELETE_TASK", "BULK_UPDATE_TASK", "UPDATE_TASK_STATUS", "UPDATE_TASK_DUE_DATE",
  "CREATE_SCHEDULE", "UPDATE_SCHEDULE", "DELETE_SCHEDULE",
  "CREATE_EXPENSE", "UPDATE_EXPENSE", "DELETE_EXPENSE",
  "CREATE_RECURRING_EXPENSE", "UPDATE_RECURRING_EXPENSE", "DELETE_RECURRING_EXPENSE",
  "CREATE_REVENUE", "UPDATE_REVENUE", "DELETE_REVENUE",
  "CREATE_DEPOSIT", "UPDATE_DEPOSIT", "DELETE_DEPOSIT", "LINK_DEPOSIT_REVENUE",
  "CREATE_QUOTATION", "DELETE_QUOTATION",
  "UPDATE_MEETING", "DELETE_MEETING",
  "DELETE_EMPLOYEE", "ACTIVATE_EMPLOYEE_LOGIN", "DEACTIVATE_EMPLOYEE_LOGIN",
]);

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
    // 화면이 남기는 기록 이름만 받는다. 서버가 남기는 기록(LOGIN_SUCCESS·LOGIN_FAILED 등)을 브라우저가 꾸며 넣지 못하게 한다.
    if (!CLIENT_LOG_ACTIONS.has(action)) {
      return NextResponse.json({ error: "허용되지 않은 기록입니다." }, { status: 400 });
    }

    const logLevel = level === "ERROR" ? "ERROR" : "INFO";
    const ip = clientIp(request.headers);

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
