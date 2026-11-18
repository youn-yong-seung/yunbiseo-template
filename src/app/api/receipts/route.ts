import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { privateFilePath } from "@/lib/private-files";
import { requireRouteUserOrApiKey } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;
const RECEIPT_EXTENSIONS = new Map([
  ["application/pdf", "pdf"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

/**
 * 영수증 업로드 주소 받기: POST /api/receipts { contentType, fileSize }  (로그인 세션 또는 API 키)
 * → { signedUrl, path, url, publicUrl }
 *
 * - 파일은 비공개 버킷(receipts)에 올라간다. signedUrl 은 이 경로 한 곳에만, 한 번 쓸 수 있는 업로드 주소다.
 * - url(=publicUrl, yb 호환용 이름)은 공개 주소가 아니라 윤비서 안 상대 주소(/api/files/receipts/...)다.
 *   로그인한 직원이나 API 키가 있어야 열린다. 카드 내역의 receipt_url 에 이 값을 넣는다.
 * - 경로는 서버가 정한다(직원 id 아래, 추측하기 어려운 이름). 형식·크기를 서버에서 다시 확인한다.
 */
export async function POST(request: Request) {
  const auth = await requireRouteUserOrApiKey(request);
  if (!auth.ok) return auth.response;

  const body: unknown = await request.json().catch(() => null);
  const contentType = body && typeof body === "object" ? Reflect.get(body, "contentType") : undefined;
  const fileSize = body && typeof body === "object" ? Reflect.get(body, "fileSize") : undefined;
  const extension = typeof contentType === "string" ? RECEIPT_EXTENSIONS.get(contentType) : undefined;
  if (!extension) {
    return NextResponse.json({ error: "JPG, PNG, GIF, WebP, PDF 파일만 올릴 수 있습니다." }, { status: 400 });
  }
  if (typeof fileSize !== "number" || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_RECEIPT_BYTES) {
    return NextResponse.json({ error: "영수증은 10MB 이하로 올려주세요." }, { status: 400 });
  }

  const objectPath = `${auth.actor.employee.id}/${Date.now()}-${randomUUID()}.${extension}`;
  const { data, error } = await createAdminClient().storage.from("receipts").createSignedUploadUrl(objectPath);
  if (error || !data?.signedUrl) {
    if (error) console.error("[receipts] signed upload", error.message);
    return NextResponse.json({ error: "영수증 업로드 주소를 만들지 못했습니다." }, { status: 500 });
  }

  // 저장·표시용 주소는 상대 경로로 준다. 요청한 서버 주소(Host 헤더)가 DB 에 박히지 않게 하고,
  // 도메인을 바꿔도 링크가 그대로 동작한다.
  const url = privateFilePath("receipts", objectPath);
  return NextResponse.json(
    { success: true, signedUrl: data.signedUrl, path: objectPath, url, publicUrl: url },
    { headers: { "cache-control": "no-store" } }
  );
}
