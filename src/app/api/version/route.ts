import { NextResponse } from "next/server";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";

/** 배포 버전(새 버전 알림용). 로그인한 직원만 본다. */
export async function GET() {
  const { user, authUnavailable } = await requireRouteUser();
  if (!user) return createRouteAuthErrorResponse(authUnavailable);

  return NextResponse.json({
    version: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  });
}
