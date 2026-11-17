// 강의·시험용 "테스트 회사" 샘플 데이터를 넣거나 지우는 스크립트입니다.
// 가상의 고객 3곳, 프로젝트 2개, 매출 3건, 일정 3건, 할 일 3건, 법인카드 1장과 카드내역 2건을 만듭니다.
// 모든 샘플에는 [샘플데이터] 표시가 붙어 있어 --remove 로 그것만 지울 수 있습니다.
//
// 사용법 (반드시 테스트용 Supabase 의 .env.local 에서 실행):
//   node scripts/seed-sample-data.mjs           # 무엇을 넣을지와 대상 주소만 보여 주고 멈춤
//   node scripts/seed-sample-data.mjs --yes     # 실제로 넣기
//   node scripts/seed-sample-data.mjs --remove --yes   # [샘플데이터] 표시가 붙은 것만 지우기
//
// 먼저 `npm run setup:admin` 으로 관리자 계정이 있어야 합니다(일정·할 일의 주인으로 씁니다).

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const MARK = "[샘플데이터]";

function loadEnvFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(".env.local");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("[오류] .env.local 에 NEXT_PUBLIC_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const confirmed = args.has("--yes");
const removing = args.has("--remove");
const host = new URL(url).host;

console.log(`\n대상 Supabase: ${host}`);
console.log(removing ? `할 일: ${MARK} 표시가 붙은 샘플 데이터 지우기` : "할 일: 테스트 회사 샘플 데이터 넣기");
if (!confirmed) {
  console.log("\n실제 회사 DB 가 아닌지 위 주소를 확인한 뒤, 맞으면 --yes 를 붙여 다시 실행하세요.\n");
  process.exit(0);
}

const db = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function kstIso(daysFromToday, hhmm) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const base = new Date(`${today}T${hhmm}:00+09:00`);
  return new Date(base.getTime() + daysFromToday * 86400000).toISOString();
}

function kstDate(daysFromToday) {
  return kstIso(daysFromToday, "12:00").slice(0, 10);
}

async function remove() {
  const like = `%${MARK}%`;
  // 샘플 카드에 붙은 카드내역은 적요를 고쳤어도 같이 지운다.
  const cards = must(await db.from("corporate_cards").select("id").like("memo", like), "샘플 카드 조회");
  if (cards.length) {
    const linked = must(
      await db.from("card_transactions").delete().in("card_id", cards.map((c) => c.id)).select("id"),
      "샘플 카드내역 삭제",
    );
    console.log(`  card_transactions(샘플 카드): ${linked.length}건 삭제`);
  }
  const plan = [
    ["card_transactions", "description"],
    ["corporate_cards", "memo"],
    ["tasks", "description"],
    ["schedules", "description"],
    ["revenues", "memo"],
    ["projects", "description"],
    ["customers", "memo"],
  ];
  for (const [table, column] of plan) {
    const data = must(await db.from(table).delete().like(column, like).select("id"), `${table} 삭제`);
    console.log(`  ${table}: ${data.length}건 삭제`);
  }
}

async function seed() {
  const admin = must(
    await db.from("employees").select("id, name").eq("employee_type", "관리자").eq("is_active", true)
      .order("created_at", { ascending: true }).limit(1).maybeSingle(),
    "관리자 조회",
  );
  if (!admin) throw new Error("관리자 직원이 없습니다. 먼저 npm run setup:admin 을 실행하세요.");

  const customers = must(
    await db.from("customers").insert([
      { name: "가나다상사", customer_type: "법인", representative_name: "김가나", contact_name: "이담당",
        contact_phone: "02-000-1001", contact_email: "contact@ganada.example", memo: `${MARK} 제조업 고객` },
      { name: "라마바디자인", customer_type: "개인사업자", representative_name: "박라마",
        contact_phone: "010-0000-2002", contact_email: "hello@ramaba.example", memo: `${MARK} 디자인 스튜디오` },
      { name: "사아자교육", customer_type: "법인", representative_name: "최사아", contact_name: "정담당",
        contact_phone: "031-000-3003", contact_email: "edu@saaja.example", memo: `${MARK} 교육 기관` },
    ]).select("id, name"),
    "고객 생성",
  );
  console.log(`  고객 ${customers.length}곳`);

  const projects = [];
  for (const [index, spec] of [
    { name: "가나다상사 업무자동화 컨설팅", customer: customers[0], status: "진행중" },
    { name: "사아자교육 AI 활용 교육", customer: customers[2], status: "진행예정" },
  ].entries()) {
    const number = must(await db.rpc("generate_project_number"), "프로젝트 번호");
    const row = must(
      await db.from("projects").insert({
        project_number: number,
        name: spec.name,
        client: spec.customer.name,
        customer_id: spec.customer.id,
        status: spec.status,
        start_date: kstDate(index === 0 ? -14 : 7),
        manager: admin.name,
        description: `${MARK} 강의 실습용 프로젝트`,
      }).select("id, project_number, name").single(),
      "프로젝트 생성",
    );
    projects.push(row);
  }
  console.log(`  프로젝트 ${projects.length}개 (${projects.map((p) => p.project_number).join(", ")})`);

  const revenues = must(
    await db.from("revenues").insert([
      { project_id: projects[0].id, title: "가나다상사 컨설팅 1차", total_amount: 3300000, supply_amount: 3000000,
        vat_amount: 300000, revenue_date: kstDate(-10), is_paid: true, paid_date: kstDate(-3), memo: `${MARK} 입금 완료` },
      { project_id: projects[0].id, title: "가나다상사 컨설팅 2차", total_amount: 2200000, supply_amount: 2000000,
        vat_amount: 200000, revenue_date: kstDate(0), memo: `${MARK} 세금계산서 발행 전` },
      { project_id: projects[1].id, title: "사아자교육 AI 교육 계약금", total_amount: 1100000, supply_amount: 1000000,
        vat_amount: 100000, revenue_date: kstDate(-1), is_tax_invoice_issued: true, tax_invoice_date: kstDate(-1),
        memo: `${MARK} 홈택스 발행 완료로 표시` },
    ]).select("id"),
    "매출 생성",
  );
  console.log(`  매출 ${revenues.length}건`);

  const schedules = must(
    await db.from("schedules").insert([
      { title: "가나다상사 진행 점검 미팅", start_at: kstIso(0, "15:00"), end_at: kstIso(0, "16:00"), category: "meeting",
        location: "가나다상사 회의실", project_id: projects[0].id, customer_id: customers[0].id, created_by: admin.id, description: MARK },
      { title: "사아자교육 교육 사전 회의", start_at: kstIso(2, "10:00"), end_at: kstIso(2, "11:00"), category: "meeting",
        location: "온라인", project_id: projects[1].id, customer_id: customers[2].id, created_by: admin.id, description: MARK },
      { title: "월말 매출 정리", start_at: kstIso(7, "00:00"), end_at: kstIso(7, "23:59"), all_day: true, category: "other",
        created_by: admin.id, description: MARK },
    ]).select("id"),
    "일정 생성",
  );
  must(
    await db.from("schedule_attendees").insert(schedules.map((s) => ({ schedule_id: s.id, employee_id: admin.id }))),
    "일정 담당자",
  );
  console.log(`  일정 ${schedules.length}건`);

  const tasks = must(
    await db.from("tasks").insert([
      { title: "가나다상사 2차 세금계산서 발행", due_date: kstDate(1), priority: "높음", project_id: projects[0].id,
        assigned_to: admin.id, created_by: admin.id, description: MARK },
      { title: "사아자교육 교안 초안 공유", due_date: kstDate(5), project_id: projects[1].id,
        assigned_to: admin.id, created_by: admin.id, description: MARK },
      { title: "라마바디자인 견적 문의 회신", due_date: kstDate(-1), assigned_to: admin.id, created_by: admin.id,
        description: MARK },
    ]).select("id"),
    "할 일 생성",
  );
  must(
    await db.from("task_assignees").insert(tasks.map((t) => ({ task_id: t.id, employee_id: admin.id }))),
    "할 일 담당자",
  );
  console.log(`  할 일 ${tasks.length}건`);

  const card = must(
    await db.from("corporate_cards").insert({ alias: "샘플 법인카드", last4: "0000", issuer: "샘플카드",
      holder_employee_id: admin.id, memo: MARK }).select("id").single(),
    "법인카드 생성",
  );
  must(
    await db.from("card_transactions").insert([
      { card_id: card.id, card_last4: "0000", issuer: "샘플카드", amount: 18000, merchant: "샘플 카페",
        approved_at: kstIso(-1, "14:20"), source: "manual", description: `${MARK} 고객 미팅 커피` },
      { card_id: card.id, card_last4: "0000", issuer: "샘플카드", amount: 52000, merchant: "샘플 문구",
        approved_at: kstIso(0, "11:05"), source: "manual", description: `${MARK}` },
    ]),
    "카드내역 생성",
  );
  console.log("  법인카드 1장, 카드내역 2건");
}

try {
  if (removing) await remove();
  else await seed();
  console.log("\n끝났습니다.\n");
} catch (error) {
  console.error(`\n[오류] ${error.message}\n`);
  process.exit(1);
}
