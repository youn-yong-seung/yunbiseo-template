import { appUrl } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { publicErrorMessage } from "@/lib/safe-error";
import { isSlackConfigured, sendProjectCreatedSlackMessage } from "@/lib/slack";

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const { user, authUnavailable } = await requireRouteUser();
  if (!user) {
    return createRouteAuthErrorResponse(authUnavailable);
  }

  const body = await request.json().catch(() => null);
  const requestedNumber = asTrimmedString(body?.project_number);
  if (!requestedNumber) {
    return Response.json({ error: "project_number is required" }, { status: 400 });
  }

  // 알림 내용은 요청 본문이 아니라 DB 의 프로젝트에서 가져온다(아무 문구나 슬랙에 보내지 못하게).
  const { data: project } = await createAdminClient()
    .from("projects")
    .select("id, project_number, name, status, client, customers(name)")
    .eq("project_number", requestedNumber)
    .maybeSingle();
  if (!project) {
    return Response.json({ error: "project not found" }, { status: 404 });
  }
  const projectNumber = project.project_number as string;
  const projectName = project.name as string;
  const linkedCustomer = project.customers as { name?: string } | { name?: string }[] | null;
  const customerName =
    (Array.isArray(linkedCustomer) ? linkedCustomer[0]?.name : linkedCustomer?.name) ?? (project.client as string | null) ?? null;

  // Slack 미연동(토큰 없음)이면 알림을 조용히 건너뛴다(경고 토스트 방지).
  if (!(await isSlackConfigured())) {
    return Response.json({ skipped: true });
  }

  try {
    await sendProjectCreatedSlackMessage({
      projectNumber,
      projectName,
      customerName,
      status: (project.status as string | null) ?? null,
      projectUrl: appUrl(request, `/dashboard/projects/${project.id}`),
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { error: publicErrorMessage(error, "Slack 프로젝트 알림 발송에 실패했습니다.") },
      { status: 500 }
    );
  }
}
