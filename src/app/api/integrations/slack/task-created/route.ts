import { appUrl } from "@/lib/app-url";
import { createRouteAuthErrorResponse, forbiddenResponse, requireRouteUser } from "@/lib/route-auth";
import { Forbidden, assertCanEditTask } from "@/app/api/tasks/_shared";
import { publicErrorMessage } from "@/lib/safe-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSlackConfigured, sendTaskSlackNotification } from "@/lib/slack";

function asTrimmed(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const { user, employee, authUnavailable } = await requireRouteUser();
  if (!user || !employee) {
    return createRouteAuthErrorResponse(authUnavailable);
  }

  const body = await request.json().catch(() => null);
  const taskId = asTrimmed(body?.task_id);
  if (!taskId) {
    return Response.json({ error: "task_id is required" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("tasks")
      .select("status")
      .eq("id", taskId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return Response.json({ error: "task not found" }, { status: 404 });
    }
    try {
      await assertCanEditTask(admin, taskId, employee);
    } catch (error) {
      if (error instanceof Forbidden) return forbiddenResponse(error.message);
      throw error;
    }

    // Slack 미연동이면 조용히 건너뛴다(경고 토스트 방지). 권한 확인은 그 전에 한다.
    if (!(await isSlackConfigured())) {
      return Response.json({ skipped: true });
    }

    const result = await sendTaskSlackNotification({
      taskId,
      prevStatus: null,
      newStatus: data.status as string,
      taskUrl: appUrl(request, `/dashboard/tasks/${encodeURIComponent(taskId)}`),
    });
    return Response.json({ success: true, ...result });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Slack 할일 등록 알림 발송에 실패했습니다.") },
      { status: 500 }
    );
  }
}
