import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/route-auth";
import { publicErrorMessage } from "@/lib/safe-error";

import { sendUpcomingScheduleReminderSlackMessages } from "@/lib/slack";

export async function GET(request: NextRequest) {
  // CRON_SECRET 이 없거나 짧으면 항상 거부한다(예전에는 "Bearer undefined" 로 통과됐다).
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sendUpcomingScheduleReminderSlackMessages(new Date());

    return NextResponse.json({
      success: true,
      sent: result.count,
      schedule_ids: result.scheduleIds,
    });
  } catch (error) {
    return NextResponse.json(
      { error: publicErrorMessage(error, "일정 Slack 리마인드 발송에 실패했습니다.") },
      { status: 500 }
    );
  }
}
