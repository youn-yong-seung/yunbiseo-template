import { assertInsideAllowedRoots, uploadFile, updateFileContent } from "@/lib/google-drive";

export function buildFileContent(meeting: {
  title: string;
  summary: string;
  transcript: string;
  started_at: string;
  ended_at: string | null;
}) {
  const lines: string[] = [];

  lines.push(`# ${meeting.title}`);
  lines.push("");
  lines.push(`일시: ${new Date(meeting.started_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  if (meeting.ended_at) {
    lines.push(`종료: ${new Date(meeting.ended_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`);
  }

  if (meeting.summary?.trim()) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## 요약");
    lines.push("");
    lines.push(meeting.summary.trim());
  }

  if (meeting.transcript?.trim()) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("## 전사록");
    lines.push("");
    lines.push(meeting.transcript.trim());
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * 기존 회의록 파일이 윤비서 Drive 폴더 안에 있으면 내용을 바꾸고, 없거나 밖에 있거나 지워졌으면 폴더에 새로 만든다.
 * (밖에 있는 파일 id 가 들어 있어도 그 파일은 건드리지 않는다)
 */
export async function saveMeetingFile(
  existingFileId: string | null,
  folderId: string,
  fileName: string,
  buffer: Buffer
): Promise<string | null> {
  if (existingFileId) {
    let inside = false;
    try {
      await assertInsideAllowedRoots([existingFileId], undefined, undefined, { allowRoot: false });
      inside = true;
    } catch {
      inside = false;
    }
    if (inside) {
      try {
        const updated = await updateFileContent(existingFileId, "text/plain", buffer);
        return updated.id ?? existingFileId;
      } catch {
        // 파일이 지워졌을 수 있으므로 새로 만든다.
      }
    }
  }
  const uploaded = await uploadFile(folderId, fileName, "text/plain", buffer);
  return uploaded.id ?? null;
}
