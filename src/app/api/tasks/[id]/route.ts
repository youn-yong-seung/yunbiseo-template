import { NextRequest, NextResponse } from "next/server";
import { validateApiKeyRecord } from "@/lib/api-key";
import { logInfo } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BadRequest,
  NotFound,
  errorResponse,
  normalizeText,
  parseDate,
  resolveTaskRef,
  unauthorized,
} from "@/lib/yb-api/refs";
import { parseEstimatedMinutes, parsePriority, parseStatus, resolveAssigneeIds, selectTask } from "../_shared";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 할 일 하나: GET·PATCH·DELETE /api/tasks/<번호 또는 uuid>. API 키 필수.
 * PATCH 의 note 는 설명 끝에 "[11-16 홍길동] 내용" 으로 쌓인다(yb done 2001 --note 결과).
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id: ref } = await context.params;
    const supabase = createAdminClient();
    const id = await resolveTaskRef(supabase, ref);
    const data = id ? await selectTask(supabase, id) : null;
    if (!data) throw new NotFound("Task not found");
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const apiKey = await validateApiKeyRecord(request);
    if (!apiKey) return unauthorized();
    const { id: ref } = await context.params;
    const body = await request.json();
    const supabase = createAdminClient();
    const id = await resolveTaskRef(supabase, ref);
    if (!id) throw new NotFound("Task not found");

    const { data: before } = await supabase.from("tasks").select("description").eq("id", id).maybeSingle();
    if (!before) throw new NotFound("Task not found");

    const update: Record<string, unknown> = {};
    if (body.title !== undefined) {
      const title = normalizeText(body.title);
      if (!title) throw new BadRequest("title cannot be empty");
      update.title = title;
    }
    if (body.description !== undefined) update.description = normalizeText(body.description);
    if (body.instruction !== undefined) update.instruction = normalizeText(body.instruction);

    const note = normalizeText(body.note);
    if (note) {
      const stamp = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()).slice(5);
      const base = (update.description as string | null | undefined) ?? (before.description as string | null) ?? "";
      update.description = `${base ? `${base}\n\n` : ""}[${stamp} ${apiKey.created_by ?? "API"}] ${note}`;
    }
    if (body.status !== undefined) {
      const status = parseStatus(body.status, "");
      update.status = status;
      update.completed_at = status === "완료" ? new Date().toISOString() : null;
    }
    if (body.priority !== undefined) update.priority = parsePriority(body.priority, "");
    if (body.start_date !== undefined) update.start_date = parseDate(body.start_date, "start_date");
    if (body.due_date !== undefined) update.due_date = parseDate(body.due_date, "due_date");
    if (body.project_id !== undefined) update.project_id = normalizeText(body.project_id);
    if (body.estimated_minutes !== undefined) update.estimated_minutes = parseEstimatedMinutes(body.estimated_minutes);
    if (body.actual_minutes !== undefined) {
      update.actual_minutes = parseEstimatedMinutes(body.actual_minutes, "actual_minutes");
    }

    const assigneeIds = await resolveAssigneeIds(
      supabase,
      body.assignee_ids ?? body.assignees ?? body.assignee ?? body.assigned_to,
    );
    if (assigneeIds !== undefined) update.assigned_to = assigneeIds[0] ?? null;

    if (Object.keys(update).length > 0) {
      const { error } = await supabase.from("tasks").update(update).eq("id", id);
      if (error) throw new BadRequest(error.message);
    }
    if (assigneeIds !== undefined) {
      const { error: delError } = await supabase.from("task_assignees").delete().eq("task_id", id);
      if (delError) throw new BadRequest(delError.message);
      if (assigneeIds.length > 0) {
        const { error: insError } = await supabase
          .from("task_assignees")
          .insert(assigneeIds.map((employee_id) => ({ task_id: id, employee_id })));
        if (insError) throw new BadRequest(insError.message);
      }
    }

    const data = await selectTask(supabase, id);
    logInfo("UPDATE_TASK_API", `API 할일 수정: ${id}`, { resource: "task", resource_id: id, details: update });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    if (!(await validateApiKeyRecord(request))) return unauthorized();
    const { id: ref } = await context.params;
    const supabase = createAdminClient();
    const id = await resolveTaskRef(supabase, ref);
    if (!id) throw new NotFound("Task not found");
    const { data: existing } = await supabase.from("tasks").select("id, title").eq("id", id).maybeSingle();
    if (!existing) throw new NotFound("Task not found");
    const { error } = await supabase.from("tasks").delete().eq("id", id);
    if (error) throw new BadRequest(error.message);
    logInfo("DELETE_TASK_API", `API 할일 삭제: ${existing.title}`, { resource: "task", resource_id: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    return errorResponse(error);
  }
}
