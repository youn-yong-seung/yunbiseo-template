/**
 * 직원 이름 정리·비교. DB 의 public.employee_name_key 와 같은 규칙이다.
 * - 보이지 않는 글자(제로폭·방향 제어·한글 채움·변형 선택자 등)와 제어문자를 지운다.
 * - NFKC 로 정규화한다(전각 → 반각, NFD → NFC, NBSP → 공백).
 * - 비교 키는 공백을 모두 빼고 소문자로 만든다("김 철수"와 "김철수", "ZSEC"와 "zsec"는 같은 이름).
 */
const INVISIBLE_RE =
  /[\u0000-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

/** 저장할 이름: 정규화하고 보이지 않는 글자를 지우고 공백을 한 칸으로. */
export function cleanEmployeeName(raw: string): string {
  return raw.normalize("NFKC").replace(INVISIBLE_RE, "").replace(/\s+/g, " ").trim();
}

/** 같은 사람처럼 보이는지 비교하는 키. */
export function employeeNameKey(raw: string): string {
  return cleanEmployeeName(raw).replace(/\s+/g, "").toLowerCase();
}
