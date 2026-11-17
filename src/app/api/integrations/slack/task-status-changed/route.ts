import { appUrl } from "@/lib/app-url";
import { createRouteAuthErrorResponse, forbiddenResponse, requireRouteUser } from "@/lib/route-auth";
import { Forbidden, assertCanEditTask } from "@/app/api/tasks/_shared";
import { publicErrorMessage } from "@/lib/safe-error";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSlackConfigured, sendTaskSlackNotification } from "@/lib/slack";

const TASK_STATUSES = ["백로그", "할 일", "진행중", "완료", "취소"];

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
  const newStatus = asTrimmed(body?.new_status);
  const prevStatus = asTrimmed(body?.prev_status);

  if (!taskId || !newStatus) {
    return Response.json({ error: "task_id and new_status are required" }, { status: 400 });
  }
  // 상태 값은 정해진 것만 받는다(아무 문구나 슬랙에 보내지 못하게).
  if (!TASK_STATUSES.includes(newStatus) || (prevStatus && !TASK_STATUSES.includes(prevStatus))) {
    return Response.json({ error: "알 수 없는 상태 값입니다." }, { status: 400 });
  }

  // 알림은 그 할 일을 고칠 수 있는 사람만, 실제로 바뀐 상태로만 보낸다.
  const admin = createAdminClient();
  const { data: current } = await admin.from("tasks").select("id, status").eq("id", taskId).maybeSingle();
  if (!current) return Response.json({ error: "task not found" }, { status: 404 });
  try {
    await assertCanEditTask(admin, taskId, employee);
  } catch (error) {
    if (error instanceof Forbidden) return forbiddenResponse(error.message);
    throw error;
  }
  if (current.status !== newStatus) {
    return Response.json({ error: "할 일의 지금 상태와 다릅니다." }, { status: 409 });
  }

  // Slack 미연동이면 조용히 건너뛴다(경고 토스트 방지).
  if (!(await isSlackConfigured())) {
    return Response.json({ skipped: true });
  }

  const actorName: string | null = employee.name;

  try {
    const result = await sendTaskSlackNotification({
      taskId,
      prevStatus: prevStatus || null,
      newStatus,
      taskUrl: appUrl(request, `/dashboard/tasks/${encodeURIComponent(taskId)}`),
      actorName,
    });
    return Response.json({ success: true, ...result });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Slack 할일 상태 알림 발송에 실패했습니다.") },
      { status: 500 }
    );
  }
}
