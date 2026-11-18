/**
 * 비공개 Storage 버킷(메모 이미지·영수증)의 파일을 윤비서 주소로 보여 주기 위한 공통 규칙.
 * 파일은 공개 주소가 없고, /api/files/<버킷>/<경로> 가 로그인한 직원(또는 API 키)을 확인한 뒤
 * 잠깐(60초) 쓸 수 있는 서명 주소로 넘겨 준다. 메모 본문에는 이 윤비서 주소만 저장한다.
 */
export const PRIVATE_FILE_BUCKETS = ["note-images", "project-note-images", "customer-note-images", "receipts"] as const;
export type PrivateFileBucket = (typeof PRIVATE_FILE_BUCKETS)[number];

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function isPrivateFileBucket(value: string): value is PrivateFileBucket {
  return (PRIVATE_FILE_BUCKETS as readonly string[]).includes(value);
}

/** 경로 조각마다 영문·숫자·._- 만, ".." 금지, 최대 5단계. 맞지 않으면 null. */
export function safeObjectPath(segments: string[]): string | null {
  if (segments.length === 0 || segments.length > 5) return null;
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment) || segment.includes("..")) return null;
  }
  return segments.join("/");
}

/** 브라우저·yb 가 쓸 윤비서 안 주소(상대 경로). */
export function privateFilePath(bucket: PrivateFileBucket, objectPath: string): string {
  return `/api/files/${bucket}/${objectPath.split("/").map(encodeURIComponent).join("/")}`;
}
