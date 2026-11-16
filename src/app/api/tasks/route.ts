import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BadRequest,
  errorResponse,
  normalizeText,
  parseDate,
  parseLimit,
  resolveActor,
  resolveEmployeeRef,
  resolveTaskRef,
  unauthorized,
} from "@/lib/yb-api/refs";
import { TASK_SELECT, parseEstimatedMinutes, parsePriority, parseStatus, resolveAssigneeIds, selectTask } from "./_shared";

/**
 * 할 일 외부 API (yb task·give·done 등이 사용). API 키 필수.
 *
 * GET  /api/tasks?assignee=me|이름&requester=me|이름&status=할 일,진행중&due_before=YYYY-MM-DD&sort=due&limit=50
 * POST /api/tasks  { title, instruction?, assignees?: ["이름"], due_date?, priority?, status?, project_id? }
 */
export async function GET(request: NextRequest) {
  try {
    const apiKey = await validateApiKeyRecord(request);
    if (!apiKey) return unauthorized();

    const params = request.nextUrl.searchParams;
    const supabase = createAdminClient();

    if (params.get("id")) {
      const taskId = await resolveTaskRef(supabase, params.get("id")!);
      const data = taskId ? await selectTask(supabase, taskId) : null;
      if (!data) return NextResponse.json({ error: "Task not found" }, { status: 404 });
      return NextResponse.json({ success: true, data });
    }

    // assignee 는 그 직원이 담당인 할 일(공동 담당 포함), requester 는 그 직원이 만든(맡긴) 할 일.
    const assigneeRef = params.get("assignee")?.trim();
    const assigneeId = assigneeRef ? await resolveEmployeeRef(supabase, assigneeRef, apiKey.created_by) : null;
    const requesterRef = params.get("requester")?.trim();
    const requesterId = requesterRef ? await resolveEmployeeRef(supabase, requesterRef, apiKey.created_by) : null;

    let query = supabase
      .from("tasks")
      .select(assigneeId ? `${TASK_SELECT}, mine:task_assignees!inner(employee_id)` : TASK_SELECT);
    if (assigneeId) query = query.eq("mine.employee_id", assigneeId);
    if (requesterId) query = query.eq("created_by", requesterId);

    const q = params.get("q")?.trim();
    if (q) query = query.or(`title.ilike.%${q}%,description.ilike.%${q}%`);
    const statuses = (params.get("status") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
    if (statuses.length === 1) query = query.eq("status", statuses[0]);
    if (statuses.length > 1) query = query.in("status", statuses);
    if (params.get("priority")) query = query.eq("priority", params.get("priority")!);
    if (params.get("due")) query = query.eq("due_date", params.get("due")!);
    if (params.get("due_before")) query = query.lte("due_date", params.get("due_before")!);
    if (params.get("completed_after")) query = query.gte("completed_at", params.get("completed_after")!);
    if (params.get("project")) query = query.eq("project_id", params.get("project")!);
    query =
      params.get("sort") === "due"
        ? query.order("due_date", { ascending: true, nullsFirst: false }).order("task_no", { ascending: true })
        : query.order("created_at", { ascending: false });
    query = query.limit(parseLimit(params.get("limit"), 50, 200));

    const { data, error } = await query;
    if (error) throw new BadRequest(error.message);
    const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
    return NextResponse.json({
      success: true,
      data: rows.map((row) => {
        const rest = { ...row };
        delete rest.mine;
        return rest;
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = await validateApiKeyRecord(request);
    if (!apiKey) return unauthorized();

    const body = await request.json();
    const title = normalizeText(body.title);
    if (!title) throw new BadRequest("title is required");

    const supabase = createAdminClient();
    const actor = await resolveActor(supabase, apiKey.created_by);
    // 담당자를 안 주면 부른 사람이 담당자다.
    const assigneeIds =
      (await resolveAssigneeIds(supabase, body.assignee_ids ?? body.assignees ?? body.assignee ?? body.assigned_to)) ??
      [];
    if (assigneeIds.length === 0 && actor) assigneeIds.push(actor.id);

    const status = parseStatus(body.status, "할 일");
    const { data: inserted, error } = await supabase
      .from("tasks")
      .insert({
        title,
        description: normalizeText(body.description),
        instruction: normalizeText(body.instruction),
        status,
        priority: parsePriority(body.priority, "보통"),
        assigned_to: assigneeIds[0] ?? null,
        start_date: parseDate(body.start_date, "start_date"),
        due_date: parseDate(body.due_date, "due_date"),
        project_id: normalizeText(body.project_id),
        estimated_minutes: parseEstimatedMinutes(body.estimated_minutes),
        completed_at: status === "완료" ? new Date().toISOString() : null,
        created_by: actor?.id ?? null,
      })
      .select("id")
      .single();
    if (error || !inserted) throw new BadRequest(error?.message ?? "Task insert failed");

    if (assigneeIds.length > 0) {
      const { error: assignError } = await supabase
        .from("task_assignees")
        .insert(assigneeIds.map((employee_id) => ({ task_id: inserted.id, employee_id })));
      if (assignError) throw new BadRequest(assignError.message);
    }

    const data = await selectTask(supabase, inserted.id as string);
    logInfo("CREATE_TASK_API", `API 할일 등록: ${title}`, { resource: "task", resource_id: inserted.id });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
