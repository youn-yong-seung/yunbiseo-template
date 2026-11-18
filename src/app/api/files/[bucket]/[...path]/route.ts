import { NextResponse } from "next/server";

import { isPrivateFileBucket, safeObjectPath } from "@/lib/private-files";
import { requireRouteUserOrApiKey } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ bucket: string; path: string[] }> };

/**
 * 비공개 버킷 파일 보기: GET /api/files/<버킷>/<경로>
 * 로그인한 활성 직원(또는 유효한 API 키)만. 60초짜리 서명 주소로 넘긴다(공개 주소는 없다).
 */
export async function GET(request: Request, context: RouteContext) {
  const auth = await requireRouteUserOrApiKey(request);
  if (!auth.ok) return auth.response;

  const { bucket, path } = await context.params;
  const objectPath = safeObjectPath(path ?? []);
  if (!isPrivateFileBucket(bucket) || !objectPath) {
    return NextResponse.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
  }

  const { data, error } = await createAdminClient().storage.from(bucket).createSignedUrl(objectPath, 60);
  if (error || !data?.signedUrl) {
    return NextResponse.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
  }

  return NextResponse.redirect(data.signedUrl, {
    status: 302,
    headers: { "cache-control": "private, no-store" },
  });
}
