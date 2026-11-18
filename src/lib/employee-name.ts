/**
 * 직원 이름 정리·비교. DB 의 public.employee_name_clean / employee_name_key 와 같은 규칙이다
 * (supabase/migrations/20261119100000_third_review_guards.sql). 한쪽을 고치면 다른 쪽도 같이 고친다.
 *
 * 1. 보이지 않는 글자를 지운다: 제어문자, 서식 문자(Unicode Cf 전체: 제로폭·방향 제어·BOM·태그 문자 등),
 *    결합 자소 결합기(CGJ), 한글 채움 문자, 몽골 자형 선택자, 크메르 모음 내재 문자,
 *    변형 선택자(FE00-FE0F, E0100-E01EF), 점자 빈칸.
 * 2. NFKC 로 정규화한다(전각 → 반각, NFD → NFC, 여러 공백 문자 → 일반 공백). 그 뒤 1을 한 번 더 한다.
 * 3. 공백을 한 칸으로 줄이고 앞뒤 공백을 뺀다.
 * 비교 키는 여기서 공백을 모두 빼고 소문자로 만든다("김 철수"와 "김철수", "ZSEC"와 "zsec"는 같은 이름).
 */
const INVISIBLE_RE = new RegExp(
  "[" +
    "\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u0890-\\u0891\\u08E2" +
    "\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u2800\\u3164" +
    "\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF9-\\uFFFB" +
    "\\u{110BD}\\u{110CD}\\u{13430}-\\u{1343F}\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}" +
    "\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}" +
    "]",
  "gu"
);
const SPACE_RE = /[\s\u0085\u1680\u2028\u2029]+/gu;

function stripInvisible(value: string): string {
  return value.replace(INVISIBLE_RE, "");
}

/** 저장할 이름: 정규화하고 보이지 않는 글자를 지우고 공백을 한 칸으로. */
export function cleanEmployeeName(raw: string): string {
  return stripInvisible(stripInvisible(raw ?? "").normalize("NFKC")).replace(SPACE_RE, " ").trim();
}

/** 같은 사람처럼 보이는지 비교하는 키. */
export function employeeNameKey(raw: string): string {
  return cleanEmployeeName(raw).replace(/ /g, "").toLowerCase();
}
