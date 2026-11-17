import { google } from "googleapis";

function getAuth() {
  return new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

/** 드라이브 파일·폴더 id 형식(영문·숫자·-·_). 쿼리 문자열에 그대로 넣기 전에 반드시 확인한다. */
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{5,200}$/;

export class DriveAccessError extends Error {}

export function isValidDriveId(id: unknown): id is string {
  return typeof id === "string" && DRIVE_ID_RE.test(id);
}

/** Drive 검색어 안의 문자열 값 이스케이프(\ 와 ' ). */
function escapeDriveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * 윤비서가 다뤄도 되는 최상위 폴더들(.env 의 GOOGLE_DRIVE_ROOT_FOLDER_ID 와 영역별 폴더).
 * 서비스 계정이 닿는 다른 파일(다른 공유 폴더 등)은 건드리지 않는다.
 */
export function allowedDriveRootIds(): string[] {
  return [
    process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID,
    process.env.NEXT_PUBLIC_CUSTOMERS_DRIVE_FOLDER_ID,
    process.env.NEXT_PUBLIC_PROJECTS_DRIVE_FOLDER_ID,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value && DRIVE_ID_RE.test(value)));
}

async function defaultGetParents(id: string): Promise<string[]> {
  const res = await getDrive().files.get({ fileId: id, fields: "id, parents, trashed", supportsAllDrives: true });
  return res.data.trashed ? [] : (res.data.parents ?? []);
}

/**
 * 주어진 파일·폴더가 모두 허용된 최상위 폴더(또는 그 아래)에 있는지 부모를 따라 올라가며 확인한다.
 * 하나라도 밖에 있거나 확인할 수 없으면 DriveAccessError. 최상위 폴더 설정이 없으면 항상 거부한다.
 */
export async function assertInsideAllowedRoots(
  ids: string[],
  // 시험용: 부모 조회를 바꿔 끼울 수 있다. 기본은 Drive API.
  getParents: (id: string) => Promise<string[]> = defaultGetParents,
  rootIds: string[] = allowedDriveRootIds(),
) {
  const roots = new Set(rootIds);
  if (roots.size === 0) throw new DriveAccessError("Google Drive 최상위 폴더가 설정되지 않았습니다.");
  const known = new Map<string, boolean>();

  async function inside(id: string, depth: number): Promise<boolean> {
    if (roots.has(id)) return true;
    if (depth > 30) return false;
    const cached = known.get(id);
    if (cached !== undefined) return cached;
    let parents: string[] = [];
    try {
      parents = await getParents(id);
    } catch {
      parents = [];
    }
    let ok = false;
    for (const parent of parents) {
      if (await inside(parent, depth + 1)) {
        ok = true;
        break;
      }
    }
    known.set(id, ok);
    return ok;
  }

  for (const id of ids) {
    if (!isValidDriveId(id)) throw new DriveAccessError("잘못된 Drive id 입니다.");
    if (!(await inside(id, 0))) throw new DriveAccessError("윤비서 Drive 폴더 밖의 파일은 다룰 수 없습니다.");
  }
}

export async function createFolder(name: string, parentId: string) {
  const drive = getDrive();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id, name, webViewLink",
    supportsAllDrives: true,
  });
  return res.data;
}

export async function listFiles(folderId: string) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`,
    fields: "files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, webContentLink, iconLink, thumbnailLink)",
    orderBy: "modifiedTime desc",
    pageSize: 100,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files ?? [];
}

export async function uploadFile(
  folderId: string,
  fileName: string,
  mimeType: string,
  body: Buffer
) {
  const drive = getDrive();
  const { Readable } = await import("stream");
  const stream = Readable.from(body);

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: "id, name, mimeType, size, webViewLink, webContentLink",
    supportsAllDrives: true,
  });
  return res.data;
}

export async function renameFile(fileId: string, newName: string) {
  const drive = getDrive();
  const res = await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: "id, name",
    supportsAllDrives: true,
  });
  return res.data;
}

export async function moveFile(fileId: string, fromFolderId: string, toFolderId: string) {
  const drive = getDrive();
  const res = await drive.files.update({
    fileId,
    addParents: toFolderId,
    removeParents: fromFolderId,
    fields: "id, name",
    supportsAllDrives: true,
  });
  return res.data;
}

export async function updateFileContent(
  fileId: string,
  mimeType: string,
  body: Buffer
) {
  const drive = getDrive();
  const { Readable } = await import("stream");
  const stream = Readable.from(body);

  const res = await drive.files.update({
    fileId,
    media: {
      mimeType,
      body: stream,
    },
    fields: "id, name, mimeType, size, webViewLink, webContentLink",
    supportsAllDrives: true,
  });
  return res.data;
}

/** 삭제는 영구 삭제가 아니라 휴지통으로 옮긴다(실수·악용 시 30일 안에 되살릴 수 있게). */
export async function deleteFile(fileId: string) {
  const drive = getDrive();
  await drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
}

/**
 * Google Drive resumable upload 세션을 생성하고 upload URI를 반환한다.
 * 클라이언트가 이 URI로 직접 파일을 PUT 하면 Vercel body 제한을 우회할 수 있다.
 */
export async function createResumableUploadSession(
  folderId: string,
  fileName: string,
  mimeType: string,
  fileSize: number
) {
  const auth = getAuth();
  const token = await auth.authorize();

  const metadata = {
    name: fileName,
    parents: [folderId],
  };

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(fileSize),
      },
      body: JSON.stringify(metadata),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resumable upload session 생성 실패: ${res.status} ${text}`);
  }

  const uploadUrl = res.headers.get("Location");
  if (!uploadUrl) {
    throw new Error("Google Drive가 upload URI를 반환하지 않았습니다.");
  }

  return uploadUrl;
}
