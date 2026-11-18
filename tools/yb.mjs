#!/usr/bin/env node
// 이 파일은 자동 생성된 수강생판 yb 입니다. 직접 고치지 마세요(다음 업데이트 때 덮어써집니다).
// 사용법: node tools/yb.mjs help   (또는 npm run yb -- help)
// yb — 윤비서(yunbiseo) 원격 CLI
// 윤비서 웹의 외부 API(x-api-key)를 명령어로 감싼 얇은 클라이언트.
// 사람도 쓰지만 1차 사용자는 AI 에이전트다: 출력은 JSON, 도움말은 필드 계약까지 담는다.
// Node 18+, 의존성 없음.
// allow: SIZE_OK — 의존성 없는 단일 파일 CLI 엔트리포인트.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

const VERSION = "0.9.1";

// 판(edition): "company" = 사내용, "student" = 수강생 템플릿(yunbiseo-template)에 들어가는 판.
// scripts/export-student.mjs 가 이 한 줄만 "student" 로 바꿔 수강생판을 만든다. 다른 곳을 손으로 고치지 않는다.
const EDITION = "student";
const IS_STUDENT = EDITION === "student";

// 수강생판은 설정 폴더를 따로 써서 사내 yb 설정과 섞이지 않는다.
const CONFIG_DIR = path.join(os.homedir(), ".config", IS_STUDENT ? "yunbiseo-template" : "yunbiseo");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
// 수강생판은 기본 주소가 없다. 각자 자기 윤비서 주소를 yb login --url 로 한 번 지정한다.
const DEFAULT_URL = "";

// 수강생판에서 쓸 수 있는 명령. 값이 true 면 하위 명령 전부, 배열이면 그 하위 명령만.
// 템플릿에 API 가 생길 때마다 여기에 추가한다(명령과 서버를 같이 맞춘다).
const STUDENT_COMMANDS = {
  help: true, "--help": true, "-h": true,
  version: true, "--version": true, "-v": true,
  update: true, login: true, whoami: true, auth: true, api: true,
  customer: ["list", "get", "create", "update", "contact", "contacts"],
  project: ["list", "create", "update", "status", "undo", "history", "notes", "note-add"],
  task: ["list", "get", "create", "update", "delete"],
  give: true, given: true, done: true, do: true, due: true,
  expense: ["list", "get", "create", "update"],
  deposit: ["list", "get", "create", "update", "delete"],
  revenue: ["list", "get", "create", "update", "tax-invoice"],
  card: ["list", "get", "create", "update", "delete", "receipt"],
  meeting: ["create"],
  today: true,
  schedule: ["list", "get", "create", "update", "delete"],
};

function studentAllows(command, sub) {
  if (command === undefined) return true;
  const allowed = STUDENT_COMMANDS[command];
  if (allowed === true) return true;
  return Array.isArray(allowed) && allowed.includes(sub);
}

// 윤비서 주소가 비어 있으면(수강생판 첫 실행) 지정 방법을 알려 주고 멈춘다.
// https 가 아닌 원격 주소(내 컴퓨터 localhost·127.0.0.1·::1 제외)는 키가 그대로 노출되므로 쓰지 않는다.
function requireBase(value) {
  const base = String(value || "").replace(/\/$/, "");
  if (!base) fail("윤비서 주소가 없습니다. 처음 한 번 실행: yb login --url https://내-윤비서-주소");
  let url;
  try {
    url = new URL(base);
  } catch {
    fail(`윤비서 주소가 올바르지 않습니다: ${base}`);
  }
  if (url.username || url.password) fail("윤비서 주소에 사용자 이름·비밀번호(@)를 넣을 수 없습니다.");
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    fail(`https 가 아닌 원격 주소는 쓸 수 없습니다(키가 암호화되지 않고 전송됩니다): ${url.origin}`);
  }
  return url.origin + url.pathname.replace(/\/$/, "");
}

// 대상 주소: YB_BASE_URL 환경변수는 YB_API_KEY 환경변수와 함께 줄 때만 쓴다
// (저장된 키를 환경변수 한 줄로 다른 주소에 보내지 않게).
function resolveBase(config) {
  if (process.env.YB_BASE_URL && !process.env.YB_API_KEY) {
    process.stderr.write("yb: YB_BASE_URL 은 YB_API_KEY 와 함께일 때만 씁니다. 저장된 주소로 보냅니다.\n");
  }
  const envBase = process.env.YB_BASE_URL && process.env.YB_API_KEY ? process.env.YB_BASE_URL : "";
  return requireBase(envBase || config.base_url || DEFAULT_URL);
}

// 리다이렉트를 따라가지 않는 fetch. 3xx 를 따라가면 키·코드가 다른 주소로 다시 보내질 수 있다.
async function safeFetch(url, init = {}) {
  const res = await fetch(url, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    const err = new Error(`리다이렉트 응답(${res.status})은 따라가지 않습니다. 윤비서 주소(https·www 여부)를 정확히 넣으세요.`);
    err.redirect = true;
    throw err;
  }
  return res;
}

// ---------------------------------------------------------------- config

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600); // 이미 있던 파일도 나만 읽게
  } catch {
    // 윈도우 등 권한 개념이 다른 곳은 무시
  }
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message) {
  process.stderr.write(`yb: ${message}\n`);
  process.exit(1);
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

// 외부 발행 게이트: --yes 없으면 구조화된 거부 JSON을 stdout에 찍고 종료(auth보다 먼저 호출).
function requireYes(flags) {
  if (flags.yes) return;
  printJson({
    error: "approval_required",
    message:
      "외부 발행 명령입니다. 사용자가 초안을 확인하고 명시적으로 승인한 직후에만 --yes 를 붙여 실행하세요. draft/미리보기 먼저.",
  });
  process.exit(1);
}

// ---------------------------------------------------------------- card receipt

const RECEIPT_CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

// 웹과 같은 경로: /api/receipts 에서 1회용 업로드 주소를 받아 파일을 올리고, 카드 건의 receipt_url 을 바꾼다.
// (수강생판 템플릿의 /api/receipts 는 비공개 버킷에 올리고, publicUrl 로 로그인한 직원만 열 수 있는 윤비서 주소를 준다)
async function uploadCardReceipt(id, localPath) {
  if (!id || !localPath) fail("사용법: yb card receipt <카드내역id> <영수증파일>");
  if (!fs.existsSync(localPath)) fail(`파일 없음: ${localPath}`);
  const contentType = RECEIPT_CONTENT_TYPES[path.extname(localPath).toLowerCase()];
  if (!contentType) fail("jpg, png, gif, webp, pdf 파일만 올릴 수 있습니다.");
  const buffer = fs.readFileSync(localPath);
  if (buffer.length === 0 || buffer.length > MAX_RECEIPT_BYTES) fail("영수증은 10MB 이하로 올려주세요.");

  // 없는 id에 파일만 올라가지 않도록 카드 건부터 확인한다.
  await request("GET", `/api/card-transactions/${id}`);

  const target = await request("POST", "/api/receipts", {
    body: { contentType, fileSize: buffer.length },
  });
  if (!target?.signedUrl || !target?.publicUrl) fail("영수증 업로드 주소를 받지 못했습니다.");

  const form = new FormData();
  form.append("cacheControl", "3600");
  form.append("", new Blob([buffer], { type: contentType }), path.basename(localPath));
  let uploaded;
  try {
    uploaded = await fetch(target.signedUrl, { method: "PUT", headers: { "x-upsert": "false" }, body: form });
  } catch (error) {
    fail(`영수증 업로드 실패: ${error.message}`);
  }
  if (!uploaded.ok) fail(`영수증 업로드 실패: HTTP ${uploaded.status} ${await uploaded.text()}`);

  const result = await request("PATCH", `/api/card-transactions/${id}`, {
    body: { receipt_url: target.publicUrl },
  });
  const tx = result?.data ?? {};
  printJson({
    success: true,
    id,
    merchant: tx.merchant ?? null,
    amount: tx.amount ?? null,
    approved_at: tx.approved_at ?? null,
    receipt_url: tx.receipt_url ?? target.publicUrl,
  });
}

// ---------------------------------------------------------------- http

async function request(method, apiPath, { query, body, form, soft = false } = {}) {
  const config = loadConfig();
  const apiKey = process.env.YB_API_KEY || config.api_key;
  if (!apiKey) {
    fail(
      IS_STUDENT
        ? "로그인이 필요합니다. 먼저 실행: yb login --url https://내-윤비서-주소"
        : "API 키가 없습니다. 먼저 실행: yb auth --key <API키>  (키 발급: 윤비서 웹 → 설정 → API 키)"
    );
  }
  // YB_BASE_URL/YB_API_KEY 환경변수로 대상 서버를 임시 오버라이드할 수 있다 (로컬 개발 서버 검증용)
  const base = resolveBase(config);
  // 키가 설정한 윤비서 주소 밖으로 나가지 않게 한다("@다른호스트", "//다른호스트", 절대 주소 등).
  const baseUrl = new URL(base);
  if (typeof apiPath !== "string" || !apiPath.startsWith("/") || apiPath.startsWith("//") || apiPath.includes("\\")) {
    fail(`API 경로는 /api/... 처럼 / 로 시작해야 합니다: ${apiPath}`);
  }
  const url = new URL(apiPath, baseUrl);
  if (url.origin !== baseUrl.origin) fail(`설정된 윤비서 주소(${baseUrl.origin}) 밖으로는 요청하지 않습니다: ${url.origin}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const headers = { "x-api-key": apiKey };
  const init = { method, headers };
  if (form) {
    init.body = form; // fetch가 multipart boundary를 알아서 설정
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await safeFetch(url, init);
  } catch (error) {
    if (soft && !error.redirect) return null;
    fail(`요청 실패: ${error.message} (${url.origin}${url.pathname})`);
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    // soft: 부가 정보 조회라 실패해도 본 명령은 계속한다.
    if (soft) return null;
    process.stderr.write(`yb: HTTP ${res.status} ${method} ${url.pathname}\n`);
    if (parsed) process.stderr.write(JSON.stringify(parsed, null, 2) + "\n");
    process.exit(1);
  }
  return parsed;
}

// 서버가 배열로 받는 필드 — CLI는 "a,b" 콤마 문자열로 받아 배열로 펴서 보낸다.
// (문자열 그대로 보내면 "직원을 찾지 못했습니다: a,b" 로 죽는다)
const ARRAY_BODY_FIELDS = new Set(["assignees", "attendee_ids", "assignee_ids", "assignee_names"]);

function toArrayValue(value) {
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// flag → API 필드 매핑 테이블로 body를 만든다. --json '<raw>'가 있으면 병합(명시 flag 우선).
function buildBody(flags, fieldMap) {
  let body = {};
  if (flags.json) {
    try {
      body = JSON.parse(String(flags.json));
    } catch (error) {
      fail(`--json 파싱 실패: ${error.message}`);
    }
  }
  for (const [flag, field] of Object.entries(fieldMap)) {
    if (flags[flag] === undefined) continue;
    body[field] = ARRAY_BODY_FIELDS.has(field) ? toArrayValue(flags[flag]) : flags[flag];
  }
  return body;
}

// ---------------------------------------------------------------- login (브라우저 인증)

// 셸을 거치지 않고 인자 배열로 브라우저를 연다(주소의 $() · 백틱 · & 가 명령으로 실행되지 않게).
function openBrowser(url) {
  try {
    if (!/^https?:\/\//.test(url)) return;
    if (process.platform === "darwin") {
      execFileSync("open", [url], { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execFileSync("rundll32", ["url.dll,FileProtocolHandler", url], { stdio: "ignore" });
    } else {
      execFileSync("xdg-open", [url], { stdio: "ignore" });
    }
  } catch {
    // 브라우저 자동 실행 실패는 무시 — URL은 이미 출력했다.
  }
}

function authResultPage(title, message) {
  return (
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>yb 인증</title>` +
    `<style>body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:flex;` +
    `min-height:100vh;margin:0;align-items:center;justify-content:center;background:#0f172a;color:#f1f5f9}` +
    `.card{text-align:center;padding:2.5rem}h1{font-size:1.4rem;margin:0 0 .5rem}` +
    `p{color:#94a3b8;margin:0}</style></head><body><div class="card">` +
    `<h1>${title}</h1><p>${message}</p></div></body></html>`
  );
}

// 화면에 글자를 보이지 않고 한 줄 입력받는다(API 키처럼 남이 보면 안 되는 값). 터미널이 아니면 표준입력 전체를 읽는다.
function promptSecret(question) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data.trim()));
    });
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value.trim());
      } else if (ch === "\u0003") {
        stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// 주소 확인(https, 또는 내 컴퓨터 http). 맞지 않으면 멈춘다.
function warnIfInsecure(base) {
  requireBase(base);
}

function promptStdin(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// 루프백 서버를 띄우고 브라우저를 열어 1회용 코드를 받는다(one-shot, 300초 타임아웃, state 검증).
// PKCE(S256): 브라우저로 넘기는 건 challenge 뿐이고, 코드를 키로 바꿀 때 verifier 를 같이 보낸다.
// 코드가 브라우저 기록 등으로 새어도 이 터미널이 가진 verifier 없이는 키로 바꿀 수 없다.
function createPkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function loginBrowser(base, state, challenge, requestId = null) {
  const server = http.createServer();
  let settle;
  const codePromise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  const timer = setTimeout(() => {
    settle.reject(new Error("타임아웃(300초) — 브라우저 인증이 완료되지 않았습니다. `yb login --manual` 로 다시 시도하세요."));
  }, 300000);

  server.on("request", (req, res) => {
    let reqUrl;
    try {
      reqUrl = new URL(req.url, "http://127.0.0.1");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (reqUrl.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const code = reqUrl.searchParams.get("code");
    const gotState = reqUrl.searchParams.get("state");
    if (gotState !== state) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(authResultPage("❌ 인증 실패", "state 불일치 — 요청이 위조되었을 수 있습니다."));
      settle.reject(new Error("state 불일치 — 인증 요청이 위조되었을 수 있습니다. 다시 시도하세요."));
      return;
    }
    if (!code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end(authResultPage("❌ 인증 실패", "코드가 전달되지 않았습니다."));
      settle.reject(new Error("코드 누락 — 다시 시도하세요."));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(authResultPage("✅ 인증 완료", "터미널로 돌아가세요."));
    settle.resolve(code);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const authUrl = requestId
    ? `${base}/cli-auth?request=${requestId}&port=${port}&state=${state}`
    : `${base}/cli-auth?port=${port}&state=${state}&challenge=${challenge}`;
  process.stdout.write(`브라우저에서 윤비서 로그인 후 인증을 완료하세요. 창이 열리지 않으면 아래 주소를 직접 여세요:\n\n  ${authUrl}\n\n`);
  openBrowser(authUrl);

  try {
    return await codePromise;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

// 1회용 코드를 API 키로 교환하고 저장한다. request() 대신 순수 fetch 사용(키가 아직 없음).
async function exchangeCode(base, code, flags, config, verifier) {
  let res;
  try {
    res = await safeFetch(`${base}/api/cli-auth/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, hostname: os.hostname(), code_verifier: verifier }),
    });
  } catch (error) {
    fail(`코드 교환 요청 실패: ${error.message}`);
  }
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    process.stderr.write(`yb: 로그인 실패 HTTP ${res.status}\n`);
    if (parsed) process.stderr.write(JSON.stringify(parsed, null, 2) + "\n");
    process.exit(1);
  }
  const { raw_key, name, created_by, key_prefix, employee_id } = parsed || {};
  if (!raw_key) fail("서버 응답에 raw_key 가 없습니다.");
  config.api_key = raw_key;
  // 직원명을 캐시해 whoami/auth status 가 브라우저 재로그인 없이 답하게 한다.
  if (created_by) config.employee = String(created_by);
  if (employee_id) config.employee_id = String(employee_id);
  else delete config.employee_id;
  if (flags.url) config.base_url = String(flags.url);
  saveConfig(config);
  const masked = (key_prefix ? String(key_prefix) : String(raw_key)).slice(0, 8) + "…";
  printJson({
    logged_in: true,
    employee: created_by || null,
    key_name: name || null,
    api_key: masked,
    base_url: config.base_url || DEFAULT_URL || null,
    config_path: CONFIG_PATH,
  });
}

async function login(flags) {
  const config = loadConfig();
  const base = requireBase(flags.url ? String(flags.url) : config.base_url || DEFAULT_URL);
  warnIfInsecure(base);

  const pkce = createPkce();

  // 수강생판: 먼저 로그인 요청을 등록하고 확인 코드를 받는다. 승인 화면에서 이 코드를 입력해야 승인된다
  // (남이 보낸 인증 주소를 눌러 주는 것만으로는 승인되지 않게). 사내판은 사내 서버 방식 그대로 둔다.
  if (IS_STUDENT) {
    let reg;
    try {
      const res = await safeFetch(`${base}/api/cli-auth/device`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code_challenge: pkce.challenge, hostname: os.hostname() }),
      });
      reg = await res.json().catch(() => null);
      if (!res.ok || !reg?.request_id || !reg?.user_code) fail(`로그인 요청을 만들지 못했습니다: ${reg?.error ?? res.status}`);
    } catch (error) {
      fail(`로그인 요청 실패: ${error.message}`);
    }
    process.stdout.write(`\n  확인 코드: ${reg.user_code}\n\n브라우저 승인 화면에 이 확인 코드를 입력하세요. 다른 사람에게 알려 주지 마세요.\n`);
    if (flags.manual) {
      const url = `${base}/cli-auth?request=${reg.request_id}`;
      process.stdout.write(`브라우저에서 다음 주소를 열고 승인한 뒤 나오는 코드를 복사하세요:\n\n  ${url}\n\n`);
      openBrowser(url);
      const code = (await promptStdin("코드 붙여넣기: ")).trim();
      if (!code) fail("코드가 비어 있습니다.");
      await exchangeCode(base, code, flags, config, pkce.verifier);
      return;
    }
    const state = crypto.randomBytes(16).toString("hex");
    const code = await loginBrowser(base, state, pkce.challenge, reg.request_id);
    await exchangeCode(base, code, flags, config, pkce.verifier);
    return;
  }

  if (flags.manual) {
    const url = `${base}/cli-auth?challenge=${pkce.challenge}`;
    process.stdout.write(`브라우저에서 다음 주소를 열고 윤비서 로그인 후 발급되는 코드를 복사하세요:\n\n  ${url}\n\n`);
    openBrowser(url);
    const code = (await promptStdin("코드 붙여넣기: ")).trim();
    if (!code) fail("코드가 비어 있습니다.");
    await exchangeCode(base, code, flags, config, pkce.verifier);
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  const code = await loginBrowser(base, state, pkce.challenge);
  await exchangeCode(base, code, flags, config, pkce.verifier);
}

function checkForUpdate() {}

// ---------------------------------------------------------------- 필드 매핑

const CUSTOMER_CREATE_FIELDS = {
  name: "name",
  type: "customer_type",
  representative: "representative_name",
  "business-number": "business_number",
  "contact-name": "contact_name",
  email: "contact_email",
  phone: "contact_phone",
  address: "address",
  memo: "memo",
  "tax-category": "tax_category",
  "withholding-rate": "default_withholding_rate",
  bank: "bank_name",
  account: "account_number",
  holder: "account_holder",
};

const CUSTOMER_CONTACT_FIELDS = {
  name: "name",
  position: "position",
  phone: "phone",
  email: "email",
  memo: "memo",
};

const PROJECT_CREATE_FIELDS = {
  name: "name",
  type: "type",
  description: "description",
  "customer-id": "customer_id",
  status: "status",
  start: "start_date",
  end: "end_date",
  manager: "manager",
};

const EXPENSE_CREATE_FIELDS = {
  title: "title",
  total: "total_amount",
  supply: "supply_amount",
  vat: "vat_amount",
  project: "project_id",
  type: "type_id",
  "vendor-id": "vendor_id",
  vendor: "vendor_name",
  method: "request_method",
  bank: "bank_name",
  account: "account_number",
  holder: "account_holder",
  "tax-category": "tax_category",
  "withholding-rate": "withholding_rate",
  "purchase-date": "purchase_date",
  "payment-date": "payment_date",
  "requested-payment-date": "requested_payment_date",
  "tax-invoice-received": "purchase_tax_invoice_received",
  "tax-invoice-not-required": "purchase_tax_invoice_not_required",
  "tax-invoice-date": "purchase_tax_invoice_date",
  memo: "memo",
};

const REVENUE_CREATE_FIELDS = {
  title: "title",
  total: "total_amount",
  supply: "supply_amount",
  vat: "vat_amount",
  project: "project_id",
  memo: "memo",
  date: "revenue_date",
  "paid": "is_paid",
  "paid-date": "paid_date",
  "tax-invoice": "is_tax_invoice_issued",
  "tax-invoice-date": "tax_invoice_date",
};

const DEPOSIT_FIELDS = {
  date: "deposit_date",
  amount: "amount",
  depositor: "depositor_name",
  bank: "bank_name",
  account: "account_alias",
  revenue: "revenue_id",
  message: "raw_message",
  memo: "memo",
};

const TASK_FIELDS = {
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  assignee: "assignee",
  "assigned-to": "assigned_to",
  assignees: "assignees",
  start: "start_date",
  due: "due_date",
  project: "project_id",
  "estimated-min": "estimated_minutes",
  "actual-min": "actual_minutes",
};

const MEETING_FIELDS = {
  title: "title",
  transcript: "transcript",
  summary: "summary",
  project: "project_id",
  "project-number": "project_number",
  customer: "customer_id",
  "customer-name": "customer_name",
  "started-at": "started_at",
  "ended-at": "ended_at",
};

const CARD_TRANSACTION_FIELDS = {
  amount: "amount",
  merchant: "merchant",
  description: "description",
  "receipt-url": "receipt_url",
  "card-id": "card_id",
  last4: "card_last4",
  "approved-at": "approved_at",
  status: "status",
  currency: "currency",
  "foreign-amount": "foreign_amount",
  "raw-text": "raw_text",
  "type-id": "type_id",
  "expense-id": "expense_id",
  "receipt-required": "receipt_required",
};

const SCHEDULE_CREATE_FIELDS = {
  title: "title",
  description: "description",
  start: "start_at",
  end: "end_at",
  date: "date",
  time: "time",
  "start-time": "start_time",
  "end-time": "end_time",
  "duration-min": "duration_min",
  "all-day": "all_day",
  category: "category",
  location: "location",
  project: "project_id",
  customer: "customer_id",
  lead: "lead_id",
  "created-by": "created_by",
  "assigned-to": "assigned_to",
  assignee: "assigned_to",
  assignees: "assignees",
  "attendee-ids": "attendee_ids",
};

const SCHEDULE_UPDATE_FIELDS = {
  title: "title",
  description: "description",
  date: "date",
  time: "time",
  "duration-min": "duration_min",
  "all-day": "all_day",
  start: "start_at",
  end: "end_at",
  category: "category",
  location: "location",
  assignee: "assignees",
  assignees: "assignees",
  "attendee-ids": "attendee_ids",
};

const GMAIL_MESSAGE_FIELDS = {
  subject: "subject",
  body: "body",
  references: "references",
  "thread-id": "threadId",
  "reply-to-message-id": "replyToMessageId",
  "draft-id": "draftId",
};

// 메시지 액션 라우트 바디({action, ...}) — 백엔드 zod 스키마 확정치. 조정은 이 테이블만.
const GMAIL_ACTIONS = {
  archive: { action: "archive" },
  read: { action: "read", read: true },
  unread: { action: "read", read: false },
  star: { action: "star", starred: true },
  unstar: { action: "star", starred: false },
};

function parseCsv(value) {
  if (value === undefined || value === null || value === true) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

// gmail draft/send 공통 본문: to/cc/bcc 는 콤마 → 배열, references 는 문자열(Message-ID 헤더). --json 병합은 buildBody가 처리.
function gmailMessageBody(flags) {
  const body = buildBody(flags, GMAIL_MESSAGE_FIELDS);
  for (const key of ["to", "cc", "bcc"]) {
    const list = parseCsv(flags[key]);
    if (list.length) body[key] = list;
  }
  return body;
}

const LIST_QUERY_FLAGS = ["id", "q", "status", "priority", "limit", "customer_type", "from", "to", "category", "due", "project", "last4", "missing-receipt", "missing-description", "channel", "paid", "assignee", "requester", "sort", "completed_after"];

function listQuery(flags) {
  const query = {};
  for (const key of LIST_QUERY_FLAGS) {
    if (flags[key] !== undefined) query[key] = flags[key];
  }
  if (flags.type !== undefined) query.customer_type = flags.type;
  if (flags["due-before"] !== undefined) query.due_before = flags["due-before"];
  return query;
}

// 교육관리 (강사·매칭·자료제출)

const INSTRUCTOR_FIELDS = {
  name: "name",
  email: "email",
  phone: "phone",
  "main-job": "main_job",
  bio: "bio",
  skills: "skills",
  industries: "industries",
  regions: "regions",
  tier: "tier",
  status: "status",
  grade: "grade",
  "has-business-reg": "has_business_reg",
  source: "source",
  "tally-response-id": "tally_response_id",
  "drive-folder-id": "drive_folder_id",
  "profile-pdf-drive-id": "profile_pdf_drive_id",
  "bank-name": "bank_name",
  "bank-account": "bank_account",
  "account-holder": "account_holder",
  memo: "memo",
};

const ENGAGEMENT_FIELDS = {
  instructor: "instructor",
  "instructor-id": "instructor_id",
  role: "role",
  status: "status",
  fee: "fee_amount",
  "fee-note": "fee_note",
  due: "submission_due_date",
  memo: "memo",
};

const SUBMISSION_FIELDS = {
  kind: "kind",
  title: "title",
  status: "status",
  due: "due_date",
  note: "note",
  "drive-url": "drive_url",
  "drive-file-id": "drive_file_id",
};

function instructorListQuery(flags) {
  const query = {};
  for (const key of ["q", "skill", "region", "industry", "tier", "status", "grade", "limit"]) {
    if (flags[key] !== undefined) query[key] = flags[key];
  }
  return query;
}

// ------------------------------------------------- 교육 파이프라인 보드 + 강사비 정산

function won(value) {
  const n = Number(value);
  return "₩" + (Number.isFinite(n) ? Math.round(n) : 0).toLocaleString("ko-KR");
}

// CJK(한글 등) 2칸 폭 계산 — 터미널 표 정렬용.
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function padDisplay(text, width) {
  const s = String(text);
  const gap = width - displayWidth(s);
  return s + (gap > 0 ? " ".repeat(gap) : "");
}

function truncateDisplay(text, max) {
  const s = String(text);
  if (displayWidth(s) <= max) return s;
  let out = "";
  for (const ch of s) {
    if (displayWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + "…";
}

function renderTable(header, rows) {
  const widths = header.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(String(r[i] ?? "")))),
  );
  const line = (cells) => cells.map((c, i) => padDisplay(c ?? "", widths[i])).join("  ") + "\n";
  process.stdout.write(line(header));
  process.stdout.write(widths.map((w) => "-".repeat(w)).join("  ") + "\n");
  for (const row of rows) process.stdout.write(line(row));
}

function formatDday(dDay) {
  if (dDay === null || dDay === undefined) return "미정";
  if (dDay === 0) return "D-Day";
  return dDay > 0 ? `D-${dDay}` : `D+${-dDay}`;
}

function renderEduBoard(data) {
  if (!data) fail("보드 응답에 data가 없습니다");
  const s = data.stats || {};
  process.stdout.write(
    `진행 중 교육 ${s.active_count ?? "-"}건 · 이번 달 교육일 ${s.this_month_education_count ?? "-"}건 · ` +
      `등록 매출 기준 미입금 ${won(s.unpaid_revenue_total)} · 정산 미완 ${s.unsettled_engagement_count ?? "-"}건\n\n`,
  );
  const projects = data.projects || [];
  if (!projects.length) {
    process.stdout.write("표시할 교육 프로젝트가 없습니다.\n");
    return;
  }
  const rows = projects.map((p) => {
    const src = p.stage_source === "heuristic" ? "(추정)" : p.stage_source === "mixed" ? "(!)" : "";
    const names = p.confirmed_instructors?.names || [];
    const instructors =
      names.length === 0
        ? "-"
        : names.slice(0, 2).join("·") + (names.length > 2 ? ` 외${names.length - 2}` : "");
    return [
      p.project_number ?? "-",
      truncateDisplay(p.name ?? "", 24),
      `${p.stage ?? "-"}${src}`,
      formatDday(p.d_day),
      instructors,
      `${p.submissions?.submitted ?? 0}/${p.submissions?.total ?? 0}`,
      p.revenue?.status ?? "-",
      p.settlement?.status ?? "-",
      `${Math.round((p.progress_rate ?? 0) * 100)}%`,
    ];
  });
  renderTable(["번호", "프로젝트", "단계", "D-day", "강사", "자료", "입금", "정산", "진행률"], rows);
  const hints = projects.filter((p) => p.stage_source === "mixed" && p.stage_hint);
  if (hints.length) {
    process.stdout.write("\n");
    for (const p of hints) process.stdout.write(`(!) ${p.project_number}: ${p.stage_hint}\n`);
  }
  process.stdout.write(
    "\n단계 표기 — (추정): task 템플릿 미적용, 데이터 기반 추정 / (!): task 정리 필요. 원본 JSON은 --json.\n",
  );
}

// yb engagement settle — 실행 전 금액 분해표 출력 + 확인 게이트(M6).
// 분해 규칙은 서버(settle API)와 동일: fee_amount는 공급가(supply) 해석,
// 개인 = 원천 3.3%(반올림), 사업자 = VAT 10% 가산(반올림) + 세금계산서 수취 필요.
async function engagementSettle(id, flags) {
  const usage =
    "사용법: yb engagement settle <id> --evidence-checked [--payment-date YYYY-MM-DD] [--total 총액] [--memo 메모] [--yes]";
  if (!id) fail(usage);

  const evidence = flags["evidence-checked"];
  if (evidence === undefined || evidence === "false") {
    // API 400 evidence_not_checked 게이트를 CLI에서 선제 안내 (M4)
    printJson({
      error: "evidence_not_checked",
      message:
        "증빙 확인 전에는 정산 요청을 만들 수 없습니다 (API 400 evidence_not_checked 동일). " +
        "Drive 프로젝트 폴더 06_강사료정산의 증빙(개인: 신분증·통장사본 / 사업자: 사업자등록증·통장사본)을 확인한 뒤 --evidence-checked 를 붙여 다시 실행하세요.",
    });
    process.exit(1);
  }

  const paymentDate = flags["payment-date"] !== undefined ? String(flags["payment-date"]) : null;
  if (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) {
    fail("--payment-date 는 YYYY-MM-DD 형식이어야 합니다");
  }

  const engRes = await request("GET", `/api/engagements/${encodeURIComponent(id)}`);
  const eng = engRes?.data;
  if (!eng) fail("engagement 조회 실패 — id를 확인하세요");
  if (!["확정", "강의완료"].includes(eng.status)) {
    fail(
      `정산 요청은 status 확정|강의완료 에서만 가능합니다 (현재: ${eng.status}). 먼저: yb engagement update ${id} --status 확정`,
    );
  }

  const insRes = await request("GET", `/api/instructors/${encodeURIComponent(eng.instructor_id)}`);
  const ins = insRes?.data || {};
  const bankName = (ins.bank_name || "").trim();
  const bankAccount = (ins.bank_account || "").trim();
  const accountHolder = (ins.account_holder || "").trim();
  if (!bankName || !bankAccount || !accountHolder) {
    printJson({
      error: "missing_bank_info",
      message: `강사 정산 계좌가 등록되어 있지 않습니다. 먼저 등록하세요: yb instructor update ${eng.instructor_id} --bank-name 은행 --bank-account 계좌번호 --account-holder 예금주`,
    });
    process.exit(1);
  }

  let overrideTotal = null;
  if (flags.total !== undefined) {
    // 값 없이 --total 만 주면 파서가 true를 넣는다 → Number(true)=1 로 1원 정산되는 사고 방지.
    if (typeof flags.total !== "string" || !/^\d+$/.test(flags.total.trim())) {
      fail(`--total 은 숫자 값이 필요합니다 (예: --total 1650000)\n${usage}`);
    }
    overrideTotal = Math.round(Number(flags.total.trim()));
    if (!Number.isFinite(overrideTotal) || overrideTotal <= 0) fail("--total 은 1원 이상 숫자여야 합니다");
  }
  const fee =
    eng.fee_amount === null || eng.fee_amount === undefined ? null : Math.round(Number(eng.fee_amount));
  if (overrideTotal === null && (!fee || fee <= 0)) {
    fail(
      `engagement에 fee_amount가 없습니다. 먼저 입력하거나(--total 로 총액 지정도 가능): yb engagement update ${id} --fee 금액`,
    );
  }

  // 서버(settle API)와 동일 분기 — 미리보기용. 최종 값은 서버 응답이 정본.
  const isBusiness = ins.has_business_reg === true;
  let total;
  let supply;
  let vat;
  let withholding;
  if (isBusiness) {
    withholding = 0;
    if (overrideTotal !== null) {
      total = overrideTotal;
      supply = Math.round(total / 1.1);
      vat = total - supply;
    } else {
      supply = fee;
      vat = Math.round(supply * 0.1);
      total = supply + vat;
    }
  } else {
    total = overrideTotal ?? fee;
    supply = total;
    vat = 0;
    withholding = Math.round(total * 0.033);
  }
  const net = total - withholding;

  process.stdout.write(
    [
      "",
      `정산 요청 미리보기 — ${eng.project_number ?? "?"} 강사비 — ${eng.instructor_name}`,
      `  구분        : ${isBusiness ? "사업자 (VAT 10% 가산 · 세금계산서 수취 필요)" : "개인 (사업소득 원천징수 3.3%)"}`,
      `  공급가      : ${won(supply)}${overrideTotal === null ? "  (engagement fee_amount = 공급가 해석)" : "  (--total 역산)"}`,
      `  VAT         : ${won(vat)}`,
      `  원천세(3.3%): ${won(withholding)}`,
      `  총액        : ${won(total)}`,
      `  실지급액    : ${won(net)}`,
      `  지급희망일  : ${paymentDate ?? "(미지정 — 서버가 강의월 익월 15일로 계산, 토요일 +2일 / 일요일 +1일)"}`,
      `  입금 계좌   : ${bankName} ${bankAccount} (${accountHolder})`,
      "",
      "  ※ 등록은 지출요청(requested) 큐까지입니다 — 승인·지급은 기존 expense 워크플로우.",
      "  ※ B2C 정산(순매출 기준 재산정, 교육 종료 후 30일 이내 지급)은 --payment-date 필수입니다.",
      "",
    ].join("\n"),
  );

  if (!flags.yes) {
    const answer = (await promptStdin("이 분해표대로 정산 요청을 생성할까요? (yes/no): ")).trim();
    if (!/^y(es)?$/i.test(answer)) {
      printJson({ cancelled: true, message: "정산 요청을 생성하지 않았습니다." });
      return;
    }
  }

  const body = { evidence_checked: true };
  if (paymentDate) body.requested_payment_date = paymentDate;
  if (overrideTotal !== null) body.total_amount = overrideTotal;
  if (flags.memo !== undefined) body.memo = String(flags.memo);
  printJson(await request("POST", `/api/engagements/${encodeURIComponent(id)}/settle`, { body }));
}

// ---------------------------------------------------------------- 도움말

const HELP = "";

const STUDENT_HELP = `yb — 윤비서 CLI (수강생판, AI 에이전트 친화)

처음 한 번
  yb login --url https://내-윤비서-주소      터미널에 확인 코드가 뜨고 브라우저가 열린다. 승인 화면에 그 코드를 입력하면 키가 발급·저장된다(90일)
  yb login --manual                         브라우저가 자동으로 안 돌아올 때: 승인 후 나온 코드를 복사해 붙여넣는다
  yb auth --url <주소>                       마이페이지 → 내 API 키에서 만든 키로 연결. 실행하면 키를 화면에 안 보이게 붙여넣는다
                                            (키를 명령줄에 쓰면 셸 기록에 남는다. 파이프도 된다: printf '%s' "$키" | yb auth --url <주소>)
  yb whoami                                 이 키의 주인(나) 확인 — 서버에 물어본다. AI 에이전트는 yb login 대신 이걸 쓴다
  yb auth status                            저장된 주소·키(앞 8자) 확인
  설정 파일: ~/.config/yunbiseo-template/config.json

지금 쓸 수 있는 명령 (출력은 모두 JSON)
  yb expense list|get <id>
  yb expense create --title 제목 --total 총액 [--vendor 거래처] [--memo 메모]
  yb expense update <id> [--title] [--total] [--memo]
  yb deposit list|get|create|update|delete
      create --date YYYY-MM-DD --amount 금액 --depositor 입금자 [--bank] [--account]
  yb meeting create --transcript 전사록 [--title 제목]
  yb api GET|POST|PATCH|DELETE /api/경로 [--q '{"key":"value"}'] [--json '{...}']

오늘·일정 (날짜는 YYYY-MM-DD 또는 오늘|내일|모레|금|다음주 화|11-25, 시각은 HH:MM, 모두 한국 시간)
  yb today                                  내 열린 할 일(기한별) + 오늘 내 일정
  yb schedule list [--from 날짜] [--to 날짜] [--assignee me|이름] [--q 검색어] [--category] [--limit N]
  yb schedule get <일정id>
  yb schedule create --title 제목 --date "다음주 화" --time 14:00 [--duration-min 60] [--location 장소]
                     [--category meeting|education|content|sales|personal|other] [--assignees 이름,이름] [--description]
      · 띄어쓴 날짜는 따옴표로 감싼다. 종일 일정: --date 11-25 --all-day true. 담당자를 안 주면 나(만든 사람)가 담당자
      · meeting 유형이고 구글 캘린더가 연결돼 있으면 웹 화면처럼 캘린더·미트 링크도 만든다(연결 없으면 윤비서에만 저장)
  yb schedule update <일정id> [--title] [--date] [--time] [--duration-min] [--location] [--category] [--assignees]
  yb schedule delete <일정id>                만든 사람·참석자·관리자만 고치고 지울 수 있다

고객
  yb customer list [--q 검색어] [--type 개인|개인사업자|법인] [--limit N]
  yb customer get <고객id|이름>               고객 한 명 + 담당자 목록
  yb customer create --name 이름 [--type 개인|개인사업자|법인] [--phone] [--email] [--memo]
      · 같은 이름이 있으면 새로 만들지 않고 기존 고객을 돌려준다(created:false)
  yb customer update <id> [--name] [--type] [--phone] [--email] [--memo]
  yb customer contact list|add|update|delete <고객> ...   담당자 (add --name 이름 [--position] [--phone] [--email])

프로젝트 (번호는 YY-N, 예: 26-3)
  yb project list [--q 검색어|번호] [--status 진행중] [--limit N]
  yb project create --name 이름 [--type 유형이름] [--customer-id 고객id] [--status] [--start YYYY-MM-DD] [--end] [--manager]
  yb project update <번호|id> [--name] [--type] [--customer-id] [--start] [--end] [--manager] [--description]
  yb project status <번호> <진행예정|진행중|완료|보류|취소> [-m 이유]   단계 바꾸기, 이력에 바꾼 사람·이유가 남는다
  yb project undo <번호> [-m 이유]           직전 단계로 되돌리기
  yb project history <번호>                  단계 이력
  yb project notes <번호>                    메모 보기
  yb project note-add <번호> --content "본문"   메모 쓰기(첫 줄이 제목)

할 일 (번호는 2001부터)
  yb give <담당자|나> "지시 그대로" [--due 내일|금|3일|11-20] [--project 26-3] [--priority 높음]
  yb given                                  내가 맡긴 일
  yb do <번호…>  /  yb done <번호…> [--note "결과"]  /  yb due <번호> <언제>
  yb task list [--assignee me|이름] [--requester me|이름] [--status "할 일,진행중"] [--due-before YYYY-MM-DD] [--sort due]
  yb task get|update|delete <번호>
  yb task create --title 제목 [--due YYYY-MM-DD] [--priority 높음|보통|낮음] [--assignee 이름] [--project 프로젝트id]

매출·세금계산서
  yb revenue list [--q 검색어] [--project 26-3] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--paid true|false] [--tax-invoice false] [--limit N]
  yb revenue get <매출id>
  yb revenue create --title 제목 --total 총액(부가세 포함) [--project 26-3] [--date YYYY-MM-DD] [--memo]
  yb revenue update <매출id> [--title] [--total] [--project] [--date] [--paid true --paid-date YYYY-MM-DD] [--memo]
  yb revenue update <매출id> --tax-invoice true [--tax-invoice-date YYYY-MM-DD]
      · 볼타 연결이 없을 때: 홈택스에서 직접 발행한 뒤 '발행함'으로만 표시한다
  yb revenue tax-invoice status <매출id>      발행 미리보기와 못 하는 이유(볼타 미연결, 고객 사업자번호 없음 등)
  yb revenue tax-invoice issue <매출id> --yes  볼타로 국세청 발행. 외부 발행이라 사람이 미리보기를 확인한 뒤에만 --yes
  yb revenue tax-invoice sync <매출id>        발행중으로 멈춘 건 상태 다시 확인

법인카드 (카드 문자 연동 방법은 SETUP.md '법인카드 문자 연동')
  yb card list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--last4 1234] [--missing-description true] [--status pending|confirmed|ignored] [--q 검색어]
  yb card get <id>
  yb card update <id> --description "고객 미팅 커피 3잔" [--status confirmed|ignored]   적요 적기
  yb card create --amount 금액 --merchant 가맹점 [--approved-at YYYY-MM-DD] [--last4 1234] [--description]   문자로 안 들어온 건 손으로 넣기
  yb card delete <id>
  yb card receipt <id> <영수증 파일>   영수증(jpg/png/gif/webp/pdf, 10MB 이하)을 올리고 그 카드 건에 연결 (직원만 열 수 있는 주소)
`;

const UPDATE_HELP = {
  customer: "사용법: yb customer update <id> [--name] [--type 개인|개인사업자|법인] [--representative] [--business-number] [--contact-name] [--email] [--phone] [--address] [--memo] [--tax-category] [--withholding-rate 0.033] [--bank] [--account] [--holder] [--json '{...}']\n",
  project: "사용법: yb project update <id> [--name] [--type 에이전시|교육|콘텐츠|내부|기타] [--description] [--customer-id] [--status] [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--manager] [--json '{...}']\n",
  expense: "사용법: yb expense update <id> [--title] [--total] [--supply] [--vat] [--project] [--type] [--vendor-id] [--vendor] [--method] [--bank] [--account] [--holder] [--tax-category] [--withholding-rate] [--purchase-date] [--payment-date] [--requested-payment-date] [--tax-invoice-received] [--tax-invoice-not-required] [--tax-invoice-date] [--memo] [--json '{...}']\n",
  revenue: "사용법: yb revenue update <id> [--title] [--total] [--supply] [--vat] [--project] [--memo] [--date YYYY-MM-DD] [--paid true|false] [--paid-date YYYY-MM-DD] [--tax-invoice true|false] [--tax-invoice-date YYYY-MM-DD] [--json '{...}']\n",
  schedule: "사용법: yb schedule update <id> [--title] [--date YYYY-MM-DD] [--start ISO] [--end ISO] [--category other|meeting|education|content|sales|personal] [--location] [--assignees <직원이름|id,...>] [--json '{...}']\n",
};

function isHelpRequested(flags) {
  return flags.help !== undefined;
}

// ---------------------------------------------------------------- 할 일 단축 명령 (today/give/given/done/do/due)
// 말로 일을 시키고 받는 흐름: "홍길동한테 이거 내일까지" → yb give, "3186 끝났어" → yb done 3186.
// 날짜는 모두 한국 시간 기준이다.

const OPEN_TASK_STATUSES = "할 일,진행중";
const WEEKDAY_INDEX = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const WEEKDAY_LABEL = ["일", "월", "화", "수", "목", "금", "토"];

function kstToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

function addDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayOf(ymd) {
  return new Date(`${ymd}T00:00:00Z`).getUTCDay();
}

function addBusinessDays(ymd, count) {
  let day = ymd;
  let left = count;
  while (left > 0) {
    day = addDays(day, 1);
    const w = weekdayOf(day);
    if (w !== 0 && w !== 6) left -= 1;
  }
  return day;
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function shortDate(ymd) {
  return ymd ? `${ymd.slice(5)}(${WEEKDAY_LABEL[weekdayOf(ymd)]})` : "기한 없음";
}

// 기한 표현 → YYYY-MM-DD. 오늘·내일·모레, 금(요일)·다음주 월, N일(영업일 기준 N일 뒤), 10-20·10/20·2026-10-20.
function parseDue(text, today = kstToday()) {
  const raw = String(text).trim().replace(/\s+/g, " ");
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (raw === "오늘") return today;
  if (raw === "내일") return addDays(today, 1);
  if (raw === "모레") return addDays(today, 2);
  const business = raw.match(/^(\d+)\s*(영업)?일(\s*뒤|\s*후)?$/);
  if (business) return addBusinessDays(today, Number(business[1]));
  const weekday = raw.match(/^(다음\s*주\s*)?([일월화수목금토])(요일)?$/);
  if (weekday) {
    const target = WEEKDAY_INDEX[weekday[2]];
    const w = weekdayOf(today);
    if (weekday[1]) {
      const nextMonday = addDays(today, ((8 - w) % 7) || 7);
      return addDays(nextMonday, (target + 6) % 7);
    }
    return addDays(today, (target - w + 7) % 7);
  }
  const monthDay = raw.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (monthDay) {
    const year = Number(today.slice(0, 4));
    const pad = (n) => String(n).padStart(2, "0");
    let candidate = `${year}-${pad(monthDay[1])}-${pad(monthDay[2])}`;
    if (candidate < today) candidate = `${year + 1}-${pad(monthDay[1])}-${pad(monthDay[2])}`;
    return candidate;
  }
  fail(`기한을 알아듣지 못했습니다: "${raw}" (예: 오늘, 내일, 금, 다음주 월, 3일, 10-20, 2026-10-20)`);
}

// 지시 원문에서 제목을 만든다: 첫 줄, 50자까지.
function titleFromInstruction(text) {
  const firstLine = String(text).split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine.length > 50 ? `${firstLine.slice(0, 50)}…` : firstLine;
}

function myName() {
  const name = loadConfig().employee;
  if (!name) fail("직원명을 알 수 없습니다. `yb whoami`로 확인하세요.");
  return name;
}

// 서버에 "이 API 키 주인이 누구냐"를 묻는다(GET /api/me). 수강생 템플릿 서버에는 있고,
// 없는 서버(404)거나 실패하면 null. 성공하면 직원명·id 를 설정에 캐시한다.
async function fetchMe() {
  const res = await request("GET", "/api/me", { soft: true });
  const employee = res?.employee;
  if (!employee?.name) return null;
  const config = loadConfig();
  config.employee = String(employee.name);
  if (employee.id) config.employee_id = String(employee.id);
  saveConfig(config);
  return res;
}

// 직원명이 필요한 명령(today·given 등)용: 캐시가 없으면 서버에 한 번 물어 채운다.
async function ensureMyName() {
  if (loadConfig().employee) return loadConfig().employee;
  await fetchMe();
  return myName();
}

function assigneeNames(task) {
  return (task.assignees ?? []).map((a) => a.employees?.name).filter(Boolean);
}

function taskLine(task, today, { showAssignee = false } = {}) {
  const due = task.due_date;
  let when = shortDate(due);
  if (due && task.status !== "완료") {
    const late = daysBetween(due, today);
    if (late > 0) when += ` ${late}일 지남`;
    else if (late === 0) when += " 오늘";
  }
  const projectNo = task.projects?.project_number;
  const project = projectNo && !task.title.includes(projectNo) ? ` [${projectNo}]` : "";
  const status = task.status === "진행중" ? " (진행중)" : task.status === "완료" ? " (완료)" : "";
  const who = showAssignee ? ` → ${assigneeNames(task).join(", ") || "미배정"}` : "";
  return `  #${task.task_no} ${task.title}${project}${status} · ${when}${who}`;
}

function taskUrl(task) {
  const base = resolveBase(loadConfig());
  return `${base}/dashboard/tasks/${task.id}`;
}

async function fetchTasks(query) {
  const res = await request("GET", "/api/tasks", { query: { sort: "due", limit: 200, ...query } });
  return res?.data ?? [];
}

function bucketByDue(tasks, today) {
  const weekEnd = addDays(today, 7);
  const buckets = { overdue: [], today: [], week: [], later: [], none: [] };
  for (const task of tasks) {
    const due = task.due_date;
    if (!due) buckets.none.push(task);
    else if (due < today) buckets.overdue.push(task);
    else if (due === today) buckets.today.push(task);
    else if (due <= weekEnd) buckets.week.push(task);
    else buckets.later.push(task);
  }
  return buckets;
}

async function fetchSalesFollowups(who, minIdle, { soft = false } = {}) {
  const res = await request("GET", "/api/sales/followups", {
    query: { assignee: who, min_idle: minIdle },
    soft,
  });
  return res?.data ?? [];
}

async function cmdFollowup(flags) {
  const who = flags.all ? "all" : flags.who ? String(flags.who) : "me";
  const minIdle = flags.days !== undefined ? Number(flags.days) : 7;
  const rows = await fetchSalesFollowups(who, minIdle);
  if (flags.json) return printJson(rows);
  const label = who === "all" ? "전체" : who === "me" ? myName() : who;
  const quiet = rows.filter((p) => !p.has_next_step);
  const planned = rows.length - quiet.length;
  const line = (p) => {
    const owners = p.assignees.length ? p.assignees.map((a) => a.name).join(",") : "담당 없음";
    return `  ${p.project_number} ${p.name} · ${p.status} · ${p.idle_days}일 (마지막 ${p.last_kind} ${p.last_date.slice(5)}) · ${owners}`;
  };
  const recent = quiet.filter((p) => p.idle_days < 30);
  const stale = quiet.filter((p) => p.idle_days >= 30);
  const out = [`영업 후속 · ${label} · 상담중·견적발송 중 마지막 활동 ${minIdle}일 이상`, ""];
  if (recent.length) out.push(`연락할 때 ${recent.length}`, ...recent.sort((a, b) => b.idle_days - a.idle_days).map(line), "");
  if (stale.length) out.push(`30일 넘게 조용, 계속할지 정할 것 ${stale.length}`, ...stale.map(line), "");
  if (!quiet.length) out.push("조용한 영업 프로젝트가 없습니다.", "");
  if (planned) out.push(`다음 일정·할 일이 잡혀 있어 뺀 것 ${planned}건`);
  out.push("연락했으면 메모·할 일·일정을 남기거나 yb project status <번호> <단계> -m 이유");
  process.stdout.write(out.join("\n").trimEnd() + "\n");
}

async function cmdToday(flags) {
  const who = flags.who ? String(flags.who) : "me";
  const name = who === "me" ? await ensureMyName() : who;
  const myId = who === "me" ? loadConfig().employee_id : null;
  const today = kstToday();
  const [mine, given, schedules] = await Promise.all([
    fetchTasks({ assignee: who, status: OPEN_TASK_STATUSES }),
    fetchTasks({ requester: who, status: OPEN_TASK_STATUSES, due_before: addDays(today, -1) }),
    request("GET", "/api/schedules", {
      query: {
        from: `${today}T00:00:00+09:00`,
        to: `${today}T23:59:59+09:00`,
        limit: 100,
        ...(IS_STUDENT ? { assignee: who } : {}),
      },
    }),
  ]);
  // 내 일정 = 내가 참석자(담당자)이거나 내가 만든 일정
  const myEvents = (schedules?.data ?? []).filter(
    (event) =>
      (event.attendees ?? []).some((a) => a.employees?.name === name) ||
      (myId && event.created_by === myId),
  );
  const givenLate = given.filter((task) => assigneeNames(task).some((n) => n !== name));

  if (flags.json) {
    printJson({ who: name, today, tasks: mine, my_schedules: myEvents, given_overdue: givenLate });
    return;
  }
  const buckets = bucketByDue(mine, today);
  const out = [`오늘 할 일 · ${name} · ${shortDate(today)}`, ""];
  const section = (label, list, limit = 30) => {
    if (!list.length) return;
    out.push(`${label} ${list.length}`);
    for (const task of list.slice(0, limit)) out.push(taskLine(task, today));
    if (list.length > limit) out.push(`  … 외 ${list.length - limit}건`);
    out.push("");
  };
  section("기한 지남", buckets.overdue);
  section("오늘 마감", buckets.today);
  section("7일 안", buckets.week);
  section("그 뒤", buckets.later, 10);
  section("기한 없음", buckets.none, 10);
  if (!mine.length) out.push("열린 할 일이 없습니다.", "");
  if (myEvents.length) {
    out.push(`오늘 일정 ${myEvents.length}`);
    for (const event of myEvents) {
      const time = event.all_day
        ? "종일"
        : new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(event.start_at ?? event.start_time ?? event.start));
      out.push(`  ${time} ${event.title}`);
    }
    out.push("");
  }
  if (givenLate.length) out.push(`내가 맡긴 일 중 기한 지남 ${givenLate.length}건 → yb given`);
  if (IS_STUDENT && !myEvents.length) out.push("오늘 일정이 없습니다.");
  // 영업 후속 확인은 사내 윤비서에만 있다.
  const sales = IS_STUDENT ? [] : await fetchSalesFollowups(who, 7, { soft: true }).catch(() => []);
  const quietSales = sales.filter((p) => !p.has_next_step);
  if (quietSales.length) out.push(`영업 중 프로젝트 ${quietSales.length}건이 7일 넘게 조용 → yb followup`);
  process.stdout.write(out.join("\n").trimEnd() + "\n");
}

// 고객 id(UUID) 또는 이름을 받아 id로 바꾼다. 이름이 정확히 하나만 맞을 때만 통과시킨다.
async function resolveCustomerId(ref) {
  const value = String(ref ?? "").trim();
  if (!value) fail("고객 id 또는 이름이 필요합니다");
  if (/^[0-9a-f-]{36}$/i.test(value)) return value;
  const res = await request("GET", "/api/customers", { query: { q: value, limit: 50 } });
  const matches = (res?.data ?? []).filter((c) => c.name === value);
  if (matches.length === 0) fail(`이름이 정확히 같은 고객이 없습니다: ${value}. 비슷한 이름은 yb customer list --q "${value}" 로 찾으세요`);
  if (matches.length > 1) {
    fail(`같은 이름의 고객이 ${matches.length}명입니다. id로 지정하세요:\n${matches.map((c) => `  ${c.id}  ${c.name} (${c.customer_type ?? "-"}, ${c.contact_phone ?? "연락처 없음"})`).join("\n")}`);
  }
  return matches[0].id;
}

async function resolveProjectId(ref) {
  const value = String(ref).trim();
  if (/^[0-9a-f-]{36}$/i.test(value)) return value;
  const res = await request("GET", "/api/projects", { query: { q: value, limit: 20 } });
  const match = (res?.data ?? []).find((p) => p.project_number === value);
  if (!match) fail(`프로젝트를 찾지 못했습니다: ${value}`);
  return match.id;
}

// 수강생 템플릿은 단계가 더 단순하다(템플릿 src/lib/project-status.ts 와 같아야 한다).
const PROJECT_STAGES = IS_STUDENT
  ? ["진행예정", "진행중", "완료", "보류", "취소"]
  : ["상담중", "견적발송", "계약완료", "준비중", "진행중", "완료", "보류", "취소"];

function kstStamp(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${String(d.getUTCFullYear()).slice(2)}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const STAGE_SOURCE_LABEL = { create: "생성", log: "이전 로그", api: "yb", bulk: "목록", web: "웹" };

async function cmdProjectHistory(ref, flags) {
  if (!ref) fail("사용법: yb project history <26-NNN|프로젝트id>");
  const res = await request("GET", `/api/projects/${encodeURIComponent(ref)}/status-history`);
  if (flags.json) return printJson(res);
  const d = res.data;
  const out = [`${d.project_number} ${d.name} · 지금 ${d.status}`];
  if (!d.history.length) out.push("  (기록 없음)");
  for (const h of d.history) {
    const move = h.from_status ? `${h.from_status} → ${h.to_status}` : h.to_status;
    const who = h.changed_by_name ? ` · ${h.changed_by_name}` : "";
    const src = STAGE_SOURCE_LABEL[h.source] ? ` (${STAGE_SOURCE_LABEL[h.source]})` : "";
    out.push(`  ${kstStamp(h.created_at)}  ${move}${who}${src}`);
    if (h.note) out.push(`      ${h.note}`);
  }
  if (d.previous_status) out.push(`되돌리기: yb project undo ${d.project_number} → ${d.previous_status}`);
  process.stdout.write(out.join("\n") + "\n");
}

async function changeProjectStage(ref, next, note, flags) {
  const id = await resolveProjectId(ref);
  const res = await request("PATCH", `/api/projects/${id}`, { body: { status: next, status_note: note || null } });
  if (flags.json) return printJson(res);
  const d = res.data;
  const warn = res.warning ? ` (주의: ${res.warning})` : "";
  process.stdout.write(`${d.project_number} ${d.name} → ${d.status}${note ? ` · ${note}` : ""}${warn}\n`);
}

async function cmdProjectStatus(ref, stage, flags) {
  const usage = `사용법: yb project status <26-NNN|프로젝트id> <${PROJECT_STAGES.join("|")}> [-m 이유]`;
  if (!ref || !stage) fail(usage);
  if (!PROJECT_STAGES.includes(stage)) fail(`알 수 없는 단계: ${stage}\n${usage}`);
  const note = flags.note !== undefined ? String(flags.note).trim() : "";
  await changeProjectStage(ref, stage, note, flags);
}

async function cmdProjectUndo(ref, flags) {
  if (!ref) fail("사용법: yb project undo <26-NNN|프로젝트id> [-m 이유]");
  const res = await request("GET", `/api/projects/${encodeURIComponent(ref)}/status-history`);
  const d = res.data;
  if (!d.previous_status) fail(`${d.project_number}: 되돌릴 이전 단계가 기록에 없습니다 (yb project history ${d.project_number})`);
  const note = flags.note !== undefined ? String(flags.note).trim() : `되돌리기: ${d.status} → ${d.previous_status}`;
  await changeProjectStage(d.id, d.previous_status, note, flags);
}

async function cmdGive(positional, flags) {
  const [assignee, ...words] = positional;
  const instruction = (flags.text ? String(flags.text) : words.join(" ")).trim();
  if (!assignee || !instruction) {
    fail('사용법: yb give <담당자|나> "지시 그대로" [--due 내일|금|3일|10-20] [--title 제목] [--project 26-NNN] [--priority 높음]');
  }
  const today = kstToday();
  const due = flags.due ? parseDue(flags.due, today) : addBusinessDays(today, 1);
  const body = {
    title: flags.title ? String(flags.title) : titleFromInstruction(instruction),
    instruction,
    assignees: [assignee === "나" || assignee === "me" ? myName() : assignee],
    due_date: due,
  };
  if (flags.priority) body.priority = String(flags.priority);
  if (flags.project) body.project_id = await resolveProjectId(flags.project);
  if (flags["dry-run"]) {
    printJson({ dry_run: true, body });
    return;
  }
  const res = await request("POST", "/api/tasks", { body });
  const task = res.data;
  if (flags.json) return printJson(res);
  process.stdout.write(
    `#${task.task_no} 맡김 → ${assigneeNames(task).join(", ")} · 마감 ${shortDate(task.due_date)}\n  ${task.title}\n  ${taskUrl(task)}\n`,
  );
}

async function cmdGiven(flags) {
  const name = await ensureMyName();
  const today = kstToday();
  const [open, done] = await Promise.all([
    fetchTasks({ requester: "me", status: `${OPEN_TASK_STATUSES},백로그` }),
    fetchTasks({ requester: "me", status: "완료", completed_after: `${addDays(today, -7)}T00:00:00+09:00` }),
  ]);
  const toOthers = (task) => assigneeNames(task).some((n) => n !== name);
  const openOthers = open.filter(toOthers);
  const doneOthers = done.filter(toOthers);
  if (flags.json) return printJson({ open: openOthers, done_7d: doneOthers });
  const out = [`내가 맡긴 일 · ${name}`, ""];
  const late = openOthers.filter((t) => t.due_date && t.due_date < today);
  const rest = openOthers.filter((t) => !(t.due_date && t.due_date < today));
  if (late.length) {
    out.push(`기한 지남 ${late.length}`, ...late.map((t) => taskLine(t, today, { showAssignee: true })), "");
  }
  if (rest.length) {
    out.push(`진행 중 ${rest.length}`, ...rest.map((t) => taskLine(t, today, { showAssignee: true })), "");
  }
  if (doneOthers.length) {
    out.push(`최근 7일 완료 ${doneOthers.length}`, ...doneOthers.map((t) => taskLine(t, today, { showAssignee: true })), "");
  }
  if (!openOthers.length && !doneOthers.length) out.push("남에게 맡긴 열린 일이 없습니다.");
  process.stdout.write(out.join("\n").trimEnd() + "\n");
}

// done/do/due: 번호 여러 개를 한 번에 받는다(yb done 3186 3187 --note 결과).
async function cmdTaskStatus(command, positional, flags) {
  const usage = {
    done: '사용법: yb done <번호…> [--note "결과"]',
    do: "사용법: yb do <번호…>",
    due: "사용법: yb due <번호> <언제>   예) yb due 3186 금",
  }[command];
  if (command === "due") {
    const [ref, ...when] = positional;
    if (!ref || !when.length) fail(usage);
    const due = parseDue(when.join(" "));
    const res = await request("PATCH", `/api/tasks/${encodeURIComponent(ref)}`, {
      body: { due_date: due, ...(flags.note ? { note: String(flags.note) } : {}) },
    });
    if (flags.json) return printJson(res);
    process.stdout.write(`#${res.data.task_no} 마감 → ${shortDate(res.data.due_date)} · ${res.data.title}\n`);
    return;
  }
  if (!positional.length) fail(usage);
  const status = command === "done" ? "완료" : "진행중";
  const results = [];
  for (const ref of positional) {
    const body = { status };
    if (flags.note) body.note = String(flags.note);
    results.push(await request("PATCH", `/api/tasks/${encodeURIComponent(ref)}`, { body }));
  }
  if (flags.json) return printJson(results);
  for (const res of results) {
    process.stdout.write(`#${res.data.task_no} ${status} · ${res.data.title}\n`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const [, , command, ...rawRest] = process.argv;
  // done 결과 메모는 -m 으로도 받는다(git 습관).
  const rest = rawRest.map((arg) => (arg === "-m" ? "--note" : arg));
  const { positional, flags } = parseArgs(rest);
  const sub = positional[0];

  // --json-file <path>: --json과 동일하지만 값을 인자 대신 파일로 받는다.
  // 대용량 payload(예: 긴 전사록)를 넘길 때 OS 인자 길이 한도(E2BIG)를 피하기 위함.
  if (flags["json-file"] !== undefined) {
    try {
      flags.json = fs.readFileSync(String(flags["json-file"]), "utf8");
    } catch (error) {
      fail(`--json-file 읽기 실패: ${error.message}`);
    }
  }

  checkForUpdate(command);

  if (IS_STUDENT && !studentAllows(command, sub)) {
    fail(`수강생판에서는 아직 지원하지 않는 명령입니다: yb ${[command, sub].filter(Boolean).join(" ")}  (지원 명령: yb help)`);
  }

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(IS_STUDENT ? STUDENT_HELP : HELP);
      return;

    case "version":
    case "--version":
    case "-v": {
      process.stdout.write(`yb ${VERSION}\n`);
      return;
    }

    case "update": {
      if (IS_STUDENT) {
        process.stdout.write("수강생판 yb 는 윤비서 템플릿 저장소에 들어 있습니다. 저장소에서 git pull 하면 같이 업데이트됩니다.\n");
        return;
      }
      return;
    }

    case "login": {
      await login(flags);
      return;
    }

    case "whoami": {
      const config = loadConfig();
      // 수강생판: API 키 주인을 서버에 물어 답한다(설정 화면에서 만든 키를 yb auth 로 넣어도 바로 "나"가 잡힌다).
      // 사내판: 캐시가 있으면 그대로, 없을 때만 서버에 묻는다.
      if ((IS_STUDENT || !config.employee) && (process.env.YB_API_KEY || config.api_key)) {
        const me = await fetchMe();
        if (me) {
          printJson({
            employee: me.employee.name,
            employee_id: me.employee.id ?? null,
            is_admin: Boolean(me.employee.is_admin),
            via: me.via ?? null,
            source: "server",
          });
          return;
        }
      }
      if (config.employee) {
        printJson({ employee: config.employee, source: "config" });
        return;
      }
      if (IS_STUDENT) {
        printJson({
          employee: null,
          error: config.api_key ? "invalid_api_key" : "not_logged_in",
          hint: config.api_key
            ? "저장된 API 키로 윤비서에 연결하지 못했습니다. 주소(yb auth status)와 키를 확인하고, 키가 지워졌으면 마이페이지 → 내 API 키에서 새로 만들어 `yb auth --key <키> --url <주소>` 로 다시 넣으세요."
            : "아직 연결 전입니다. 마이페이지 → 내 API 키에서 키를 만든 뒤 `yb auth --key <키> --url <윤비서 주소>` 를 실행하세요.",
        });
        process.exit(1);
      }
      // 자동으로 yb login 을 실행하지 않는다 — 브라우저 팝업이 뜨므로 사용자 본인이 1회 실행해야 한다.
      printJson({
        employee: null,
        error: "employee_not_cached",
        hint: "사용자에게 터미널에서 `yb login`을 1회 실행해 브라우저 로그인을 완료해 달라고 요청하세요. AI 에이전트가 yb login 을 직접 실행하면 안 됩니다(인증 팝업 반복 원인).",
      });
      process.exit(1);
      return;
    }

    case "auth": {
      if (sub === "status") {
        const config = loadConfig();
        printJson({
          base_url: config.base_url || DEFAULT_URL || null,
          api_key: config.api_key ? config.api_key.slice(0, 8) + "…" : null,
          employee: config.employee || null,
          config_path: CONFIG_PATH,
        });
        return;
      }
      // 키는 명령줄에 쓰지 않는 것을 권장한다(셸 기록에 남는다). --key 를 빼거나 --key - 로 주면
      // 터미널에서는 화면에 안 보이게 입력받고, 파이프로 넘기면(printf ... | yb auth --url ...) 표준입력에서 읽는다.
      let keyValue = flags.key === undefined || flags.key === true || flags.key === "-" ? "" : String(flags.key);
      if (!keyValue) keyValue = await promptSecret("API 키를 붙여넣고 Enter (화면에 보이지 않습니다): ");
      if (!keyValue) fail("사용법: yb auth --url <윤비서 주소>  (실행 후 API 키를 붙여넣기)  또는  printf '%s' \"$키\" | yb auth --url <주소>");
      if (flags.url) warnIfInsecure(String(flags.url));
      const config = loadConfig();
      const previous = { ...config };
      config.api_key = keyValue.trim();
      // 수동 키 등록은 소유자를 검증하지 않으므로 이전 로그인의 직원명 캐시를 지운다.
      delete config.employee;
      delete config.employee_id;
      if (flags.url) config.base_url = String(flags.url).replace(/\/$/, "");
      saveConfig(config);
      // 새 키가 누구 것인지 서버에 확인해 캐시한다(사내 서버처럼 확인 API 가 없으면 건너뛴다).
      const me = await fetchMe();
      if (IS_STUDENT && !me) {
        saveConfig(previous);
        fail(
          "이 키로 윤비서에 연결하지 못했습니다. 주소(--url)와 키를 다시 확인하세요. 저장하지 않았습니다.\n" +
            "  · 주소 예: http://localhost:3000 또는 https://내-윤비서.vercel.app\n" +
            "  · 키는 윤비서 마이페이지 → 내 API 키에서 만든 ys_ 로 시작하는 값"
        );
      }
      printJson({
        saved: CONFIG_PATH,
        base_url: config.base_url || DEFAULT_URL || null,
        employee: me?.employee?.name ?? null,
      });
      return;
    }

    case "api": {
      const method = (positional[0] || "").toUpperCase();
      const apiPath = positional[1];
      if (!method || !apiPath) fail("사용법: yb api <GET|POST|PATCH|DELETE> </api/...> [--json '...'] [--q '{...}']");
      if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) fail(`지원하지 않는 메서드: ${method}`);
      if (!String(apiPath).startsWith("/api/")) fail("yb api 경로는 /api/ 로 시작해야 합니다(다른 주소로 키를 보내지 않습니다).");
      let query;
      if (flags.q) {
        try { query = JSON.parse(String(flags.q)); } catch (e) { fail(`--q 파싱 실패: ${e.message}`); }
      }
      const body = flags.json ? buildBody(flags, {}) : undefined;
      printJson(await request(method, apiPath, { query, body }));
      return;
    }

    case "customer": {
      const id = positional[1];
      if (sub === "list") {
        printJson(await request("GET", "/api/customers", { query: listQuery(flags) }));
      } else if (sub === "create") {
        if (!flags.name && !flags.json) fail("--name 이 필요합니다");
        printJson(await request("POST", "/api/customers", { body: buildBody(flags, CUSTOMER_CREATE_FIELDS) }));
      } else if (sub === "update") {
        if (isHelpRequested(flags)) {
          process.stdout.write(UPDATE_HELP.customer);
          return;
        }
        if (!id) fail("사용법: yb customer update <id> [필드]");
        printJson(await request("PATCH", `/api/customers/${id}`, { body: buildBody(flags, CUSTOMER_CREATE_FIELDS) }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb customer get <고객id|이름>");
        const customerId = await resolveCustomerId(id);
        const [customerRes, contactsRes] = await Promise.all([
          request("GET", `/api/customers/${customerId}`),
          request("GET", `/api/customers/${customerId}/contacts`),
        ]);
        printJson({ data: { ...customerRes.data, contacts: contactsRes.data ?? [] } });
      } else if (sub === "contact" || sub === "contacts") {
        const action = positional[1];
        const usage = "사용법: yb customer contact list <고객> | add <고객> --name 이름 [--position] [--phone] [--email] [--memo] | update <고객> <담당자id> [필드] | delete <고객> <담당자id>";
        if (!action || isHelpRequested(flags)) {
          process.stdout.write(usage + "\n");
          return;
        }
        if (!positional[2]) fail(usage);
        const customerId = await resolveCustomerId(positional[2]);
        const contactId = positional[3];
        if (action === "list") {
          printJson(await request("GET", `/api/customers/${customerId}/contacts`));
        } else if (action === "add") {
          if (!flags.name && !flags.json) fail("--name 이 필요합니다 (담당자 이름. 개인 고객이면 본인 이름)");
          printJson(await request("POST", `/api/customers/${customerId}/contacts`, { body: buildBody(flags, CUSTOMER_CONTACT_FIELDS) }));
        } else if (action === "update") {
          if (!contactId) fail("사용법: yb customer contact update <고객> <담당자id> [--name] [--position] [--phone] [--email] [--memo]");
          printJson(await request("PATCH", `/api/customers/${customerId}/contacts/${contactId}`, { body: buildBody(flags, CUSTOMER_CONTACT_FIELDS) }));
        } else if (action === "delete") {
          if (!contactId) fail("사용법: yb customer contact delete <고객> <담당자id>");
          printJson(await request("DELETE", `/api/customers/${customerId}/contacts/${contactId}`));
        } else fail(usage);
      } else fail("사용법: yb customer list|get|create|update|contact");
      return;
    }

    case "project": {
      const id = positional[1];
      if (sub === "list") {
        printJson(await request("GET", "/api/projects", { query: listQuery(flags) }));
      } else if (sub === "create") {
        // 수강생 템플릿은 유형이 선택이다(유형 목록도 각자 만든다).
        if (IS_STUDENT && !flags.json && !flags.name) fail("--name 이 필요합니다");
        if (!IS_STUDENT && !flags.json && (!flags.name || !flags.type)) fail("--name 과 --type(에이전시|교육|콘텐츠|내부|기타) 이 필요합니다");
        printJson(await request("POST", "/api/projects", { body: buildBody(flags, PROJECT_CREATE_FIELDS) }));
      } else if (sub === "update") {
        if (isHelpRequested(flags)) {
          process.stdout.write(UPDATE_HELP.project);
          return;
        }
        if (!id) fail("사용법: yb project update <id> [필드]");
        printJson(await request("PATCH", `/api/projects/${id}`, { body: buildBody(flags, PROJECT_CREATE_FIELDS) }));
      } else if (sub === "notes") {
        if (!id) fail("사용법: yb project notes <프로젝트id>");
        printJson(await request("GET", `/api/projects/${id}/notes`));
      } else if (sub === "note-add") {
        const noteUsage =
          "사용법: yb project note-add <프로젝트id> (--content \"본문\" | --file 경로) [--title 제목]";
        if (!id) fail(noteUsage);
        let content = typeof flags.content === "string" ? flags.content : "";
        if (flags.file !== undefined) {
          const fp = String(flags.file);
          if (!fs.existsSync(fp)) fail(`파일 없음: ${fp}`);
          content = fs.readFileSync(fp, "utf8");
        }
        const title = typeof flags.title === "string" ? flags.title.trim() : "";
        if (!content.trim() && !title) fail(noteUsage);
        // 서버는 title 컬럼을 쓰지 않는다(본문 첫 줄이 제목). --title 은 본문 맨 앞에 합친다.
        const merged = title ? (content.trim() ? `${title}\n\n${content}` : title) : content;
        printJson(await request("POST", `/api/projects/${id}/notes`, { body: { content: merged } }));
      } else if (sub === "apply-template") {
        if (!id) fail("사용법: yb project apply-template <26-NNN|프로젝트id> [--template 이름] [--base-date YYYY-MM-DD] [--education-date YYYY-MM-DD]");
        const body = {};
        if (flags.template !== undefined) body.template_name = String(flags.template);
        if (flags["base-date"] !== undefined) body.base_date = String(flags["base-date"]);
        if (flags["education-date"] !== undefined) body.education_date = String(flags["education-date"]);
        printJson(await request("POST", `/api/projects/${encodeURIComponent(id)}/apply-template`, { body }));
      } else if (sub === "history") {
        await cmdProjectHistory(id, flags);
      } else if (sub === "status") {
        await cmdProjectStatus(id, positional[2], flags);
      } else if (sub === "undo") {
        await cmdProjectUndo(id, flags);
      } else fail("사용법: yb project list|create|update|status|undo|history|notes|note-add|apply-template");
      return;
    }

    case "expense": {
      const id = positional[1];
      if (sub === "tax-invoice") {
        const expId = positional[1];
        if (!expId) fail("사용법: yb expense tax-invoice <매입id> --status requested|received|not_required|needed [--date YYYY-MM-DD] [--reason]");
        if (!flags.status) fail("--status requested|received|not_required|needed 가 필요합니다");
        const body = { status: String(flags.status) };
        if (flags.date !== undefined) body.date = String(flags.date);
        if (flags.reason !== undefined) body.reason = String(flags.reason);
        printJson(await request("POST", `/api/expenses/${expId}/tax-invoice`, { body }));
        return;
      }
      if (sub === "list") {
        printJson(await request("GET", "/api/expenses", { query: listQuery(flags) }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb expense get <id>");
        printJson(await request("GET", `/api/expenses/${id}`));
      } else if (sub === "create") {
        if (!flags.json && (!flags.title || !flags.total)) fail("--title 과 --total 이 필요합니다");
        printJson(await request("POST", "/api/expenses", { body: buildBody(flags, EXPENSE_CREATE_FIELDS) }));
      } else if (sub === "update") {
        if (isHelpRequested(flags)) {
          process.stdout.write(UPDATE_HELP.expense);
          return;
        }
        if (!id) fail("사용법: yb expense update <id> [필드]");
        printJson(await request("PATCH", `/api/expenses/${id}`, { body: buildBody(flags, EXPENSE_CREATE_FIELDS) }));
      } else if (["submit", "approve", "pay", "reject", "cancel"].includes(sub)) {
        if (!id) fail(`사용법: yb expense ${sub} <id>`);
        const body = flags.json ? buildBody(flags, {}) : {};
        printJson(await request("POST", `/api/expenses/${id}/${sub}`, { body }));
      } else fail("사용법: yb expense list|get|create|update|submit|approve|pay|reject|cancel|tax-invoice");
      return;
    }

    case "revenue": {
      const id = positional[1];
      if (sub === "tax-invoice") {
        const action = positional[1]; // status|issue|sync|force-reset
        const revId = positional[2];
        if (!revId) fail("사용법: yb revenue tax-invoice status|issue|sync|force-reset <매출id>");
        if (action === "status") {
          printJson(await request("GET", `/api/revenues/${revId}/tax-invoice`));
        } else if (action === "issue") {
          requireYes(flags);
          const body = flags.json ? buildBody(flags, {}) : {};
          printJson(await request("POST", `/api/revenues/${revId}/tax-invoice`, { body }));
        } else if (action === "sync") {
          printJson(await request("PATCH", `/api/revenues/${revId}/tax-invoice`, { body: { action: "sync" } }));
        } else if (action === "force-reset") {
          printJson(await request("PATCH", `/api/revenues/${revId}/tax-invoice`, { body: { action: "force-reset" } }));
        } else {
          fail("사용법: yb revenue tax-invoice status|issue|sync|force-reset <매출id>");
        }
        return;
      }
      if (sub === "list") {
        const query = listQuery(flags);
        if (flags["tax-invoice"] !== undefined) query.tax_invoice = flags["tax-invoice"];
        printJson(await request("GET", "/api/revenues", { query }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb revenue get <id>");
        printJson(await request("GET", `/api/revenues/${id}`));
      } else if (sub === "create") {
        if (!flags.json && (!flags.title || !flags.total)) fail("--title 과 --total 이 필요합니다");
        printJson(await request("POST", "/api/revenues", { body: buildBody(flags, REVENUE_CREATE_FIELDS) }));
      } else if (sub === "update") {
        if (isHelpRequested(flags)) {
          process.stdout.write(UPDATE_HELP.revenue);
          return;
        }
        if (!id) fail("사용법: yb revenue update <id> [필드]");
        printJson(await request("PATCH", `/api/revenues/${id}`, { body: buildBody(flags, REVENUE_CREATE_FIELDS) }));
      } else fail("사용법: yb revenue list|get|create|update|tax-invoice");
      return;
    }

    case "deposit": {
      const id = positional[1];
      if (sub === "list") {
        printJson(await request("GET", "/api/deposits", { query: listQuery(flags) }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb deposit get <id>");
        printJson(await request("GET", `/api/deposits/${id}`));
      } else if (sub === "create") {
        if (!flags.json && (!flags.date || !flags.amount || !flags.depositor)) fail("--date, --amount, --depositor 가 필요합니다");
        printJson(await request("POST", "/api/deposits", { body: buildBody(flags, DEPOSIT_FIELDS) }));
      } else if (sub === "update") {
        if (!id) fail("사용법: yb deposit update <id> [필드]");
        printJson(await request("PATCH", `/api/deposits/${id}`, { body: buildBody(flags, DEPOSIT_FIELDS) }));
      } else if (sub === "delete") {
        if (!id) fail("사용법: yb deposit delete <id>");
        printJson(await request("DELETE", `/api/deposits/${id}`));
      } else fail("사용법: yb deposit list|get|create|update|delete");
      return;
    }

    case "schedule": {
      const id = positional[1];
      if (sub === "list") {
        for (const key of ["from", "to"]) {
          const value = flags[key];
          if (value !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(String(value))) flags[key] = parseDue(value);
        }
        printJson(await request("GET", "/api/schedules", { query: listQuery(flags) }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb schedule get <일정id>");
        printJson(await request("GET", "/api/schedules", { query: { id } }));
      } else if (sub === "delete") {
        if (!id) fail("사용법: yb schedule delete <일정id>");
        printJson(await request("DELETE", "/api/schedules", { query: { id } }));
      } else if (sub === "create") {
        if (!flags.json && !flags.title) fail("--title 이 필요합니다");
        // --date 에 "내일", "다음주 화", "11-25" 같은 말을 줘도 YYYY-MM-DD 로 바꿔 보낸다.
        if (flags.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(flags.date))) flags.date = parseDue(flags.date);
        const body = buildBody(flags, SCHEDULE_CREATE_FIELDS);
        const attendeeIds = parseCsv(flags["attendee-ids"]);
        if (attendeeIds.length > 0) body.attendee_ids = attendeeIds;
        printJson(await request("POST", "/api/schedules", { body }));
      } else if (sub === "update") {
        if (isHelpRequested(flags)) {
          process.stdout.write(UPDATE_HELP.schedule);
          return;
        }
        if (!id) fail("사용법: yb schedule update <id> [필드]");
        if (flags.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(flags.date))) flags.date = parseDue(flags.date);
        printJson(await request("PATCH", `/api/schedules/${id}`, { body: buildBody(flags, SCHEDULE_UPDATE_FIELDS) }));
      } else fail("사용법: yb schedule list|get|create|update|delete");
      return;
    }

    case "quotation": {
      // 2026-10-18 결정: 견적서는 로컬에서 만들고 프로젝트 Drive 폴더에 파일로 관리한다. 윤비서 견적관리는 없앴다.
      fail("견적관리는 없어졌습니다(2026-10-18). 견적서는 프로젝트 Drive 폴더에 파일로 관리합니다.");
      return;
    }

    case "gmail": {
      const id = positional[1];
      if (sub === "list") {
        const query = {};
        if (flags.folder !== undefined) query.folder = flags.folder;
        if (flags.q !== undefined) query.q = flags.q;
        if (flags.label !== undefined) query.labelId = flags.label;
        if (flags["page-token"] !== undefined) query.pageToken = flags["page-token"];
        printJson(await request("GET", "/api/gmail/messages", { query }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb gmail get <메시지id>");
        printJson(await request("GET", `/api/gmail/messages/${id}`));
      } else if (sub === "draft") {
        if (!flags.json && (!flags.to || !flags.subject)) fail("--to 와 --subject 가 필요합니다");
        printJson(await request("POST", "/api/gmail/drafts", { body: gmailMessageBody(flags) }));
      } else if (sub === "send-draft") {
        requireYes(flags);
        if (!id) fail("사용법: yb gmail send-draft <draftId> --yes");
        printJson(await request("POST", `/api/gmail/drafts/${id}`, { body: {} }));
      } else if (sub === "delete-draft") {
        if (!id) fail("사용법: yb gmail delete-draft <draftId>");
        printJson(await request("DELETE", `/api/gmail/drafts/${id}`));
      } else if (sub === "send") {
        requireYes(flags);
        if (!flags.json && (!flags.to || !flags.subject)) fail("--to 와 --subject 가 필요합니다");
        printJson(await request("POST", "/api/gmail/send", { body: gmailMessageBody(flags) }));
      } else if (sub === "labels") {
        printJson(await request("GET", "/api/gmail/labels"));
      } else if (sub === "label-create") {
        if (!flags.name) fail("사용법: yb gmail label-create --name 이름");
        printJson(await request("POST", "/api/gmail/labels", { body: { name: String(flags.name) } }));
      } else if (sub === "label") {
        if (!id) fail("사용법: yb gmail label <메시지id> [--add id,id] [--remove id,id]");
        const addLabelIds = parseCsv(flags.add);
        const removeLabelIds = parseCsv(flags.remove);
        if (!addLabelIds.length && !removeLabelIds.length) fail("--add 또는 --remove 중 하나는 필요합니다");
        printJson(await request("POST", `/api/gmail/messages/${id}/actions`, { body: { action: "labels", addLabelIds, removeLabelIds } }));
      } else if (GMAIL_ACTIONS[sub]) {
        if (!id) fail(`사용법: yb gmail ${sub} <메시지id>`);
        printJson(await request("POST", `/api/gmail/messages/${id}/actions`, { body: GMAIL_ACTIONS[sub] }));
      } else {
        fail("사용법: yb gmail list|get|draft|send-draft|delete-draft|send|labels|label-create|label|archive|read|unread|star|unstar");
      }
      return;
    }

    case "today":
      await cmdToday(flags);
      return;

    case "give":
      await cmdGive(positional, flags);
      return;

    case "followup":
      await cmdFollowup(flags);
      return;
    case "given":
      await cmdGiven(flags);
      return;

    case "done":
    case "do":
    case "due":
      await cmdTaskStatus(command, positional, flags);
      return;

    case "task": {
      const id = positional[1];
      if (sub === "list") {
        printJson(await request("GET", "/api/tasks", { query: listQuery(flags) }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb task get <id>");
        printJson(await request("GET", `/api/tasks/${id}`));
      } else if (sub === "create") {
        if (!flags.json && !flags.title) fail("--title 이 필요합니다");
        printJson(await request("POST", "/api/tasks", { body: buildBody(flags, TASK_FIELDS) }));
      } else if (sub === "update") {
        if (!id) fail("사용법: yb task update <id> [필드]");
        printJson(await request("PATCH", `/api/tasks/${id}`, { body: buildBody(flags, TASK_FIELDS) }));
      } else if (sub === "delete") {
        if (!id) fail("사용법: yb task delete <id>");
        printJson(await request("DELETE", `/api/tasks/${id}`));
      } else fail("사용법: yb task list|get|create|update|delete");
      return;
    }

    case "meeting": {
      if (sub === "create") {
        if (!flags.json && !flags.transcript) fail("--transcript 가 필요합니다");
        printJson(await request("POST", "/api/meetings", { body: buildBody(flags, MEETING_FIELDS) }));
      } else fail("사용법: yb meeting create");
      return;
    }

    case "card":
    case "card-transaction": {
      const id = positional[1];
      if (sub === "list") {
        printJson(await request("GET", "/api/card-transactions", { query: listQuery(flags) }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb card get <id>");
        printJson(await request("GET", `/api/card-transactions/${id}`));
      } else if (sub === "create") {
        if (!flags.json && !flags.amount) fail("--amount 가 필요합니다");
        printJson(await request("POST", "/api/card-transactions", { body: buildBody(flags, CARD_TRANSACTION_FIELDS) }));
      } else if (sub === "update") {
        if (!id) fail("사용법: yb card update <id> [필드]");
        printJson(await request("PATCH", `/api/card-transactions/${id}`, { body: buildBody(flags, CARD_TRANSACTION_FIELDS) }));
      } else if (sub === "delete") {
        if (!id) fail("사용법: yb card delete <id>");
        printJson(await request("DELETE", `/api/card-transactions/${id}`));
      } else if (sub === "receipt") {
        await uploadCardReceipt(id, positional[2]);
      } else fail("사용법: yb card list|get|create|update|delete|receipt");
      return;
    }

    case "file": {
      if (sub === "list") {
        if (!flags.folder) fail("--folder <드라이브폴더ID> 가 필요합니다");
        printJson(await request("GET", "/api/drive/files", { query: { folderId: flags.folder } }));
      } else if (sub === "upload") {
        const localPath = positional[1];
        if (!localPath || !flags.folder) fail("사용법: yb file upload <로컬파일> --folder <드라이브폴더ID>");
        if (!fs.existsSync(localPath)) fail(`파일 없음: ${localPath}`);
        const buffer = fs.readFileSync(localPath);
        const form = new FormData();
        form.append("file", new Blob([buffer]), path.basename(localPath));
        form.append("folderId", String(flags.folder));
        printJson(await request("POST", "/api/drive/files", { form }));
      } else fail("사용법: yb file list|upload");
      return;
    }

    case "instructor": {
      const id = positional[1];
      if (sub === "list") {
        printJson(await request("GET", "/api/instructors", { query: instructorListQuery(flags) }));
      } else if (sub === "get") {
        if (!id) fail("사용법: yb instructor get <이름|id>");
        printJson(await request("GET", `/api/instructors/${encodeURIComponent(id)}`));
      } else if (sub === "create") {
        if (!flags.json && !flags.name) fail("--name 이 필요합니다");
        printJson(await request("POST", "/api/instructors", { body: buildBody(flags, INSTRUCTOR_FIELDS) }));
      } else if (sub === "update") {
        if (!id) fail("사용법: yb instructor update <이름|id> [필드]");
        printJson(await request("PATCH", `/api/instructors/${encodeURIComponent(id)}`, { body: buildBody(flags, INSTRUCTOR_FIELDS) }));
      } else if (sub === "feedback") {
        const action = positional[1];
        const target = positional[2];
        if (action === "add") {
          if (!target || !flags.content) fail("사용법: yb instructor feedback add <이름|id> --content 내용 [--project 26-NNN] [--category 기한|품질|소통|현장|기타] [--rating 1~5]");
          const body = { content: String(flags.content) };
          if (flags.project !== undefined) body.project = String(flags.project);
          if (flags.category !== undefined) body.category = String(flags.category);
          if (flags.rating !== undefined) body.rating = Number(flags.rating);
          printJson(await request("POST", `/api/instructors/${encodeURIComponent(target)}/feedback`, { body }));
        } else if (action === "list") {
          if (!target) fail("사용법: yb instructor feedback list <이름|id>");
          printJson(await request("GET", `/api/instructors/${encodeURIComponent(target)}/feedback`));
        } else fail("사용법: yb instructor feedback add|list <이름|id>");
      } else if (sub === "assign") {
        if (!flags.project || (!flags.instructor && !flags["instructor-id"])) {
          fail("사용법: yb instructor assign --project <26-NNN|id> --instructor <이름|id> [--role 주강사|보조강사|후보] [--status] [--fee 금액] [--due YYYY-MM-DD]");
        }
        printJson(await request("POST", `/api/projects/${encodeURIComponent(String(flags.project))}/engagements`, { body: buildBody(flags, ENGAGEMENT_FIELDS) }));
      } else fail("사용법: yb instructor list|get|create|update|feedback|assign");
      return;
    }

    case "engagement": {
      const id = positional[1];
      if (sub === "get") {
        if (!id) fail("사용법: yb engagement get <id>");
        printJson(await request("GET", `/api/engagements/${id}`));
      } else if (sub === "update") {
        if (!id) fail("사용법: yb engagement update <id> [--role] [--status 후보|컨택중|확정|강의완료|하차] [--fee] [--due] [--memo]");
        printJson(await request("PATCH", `/api/engagements/${id}`, { body: buildBody(flags, ENGAGEMENT_FIELDS) }));
      } else if (sub === "settle") {
        await engagementSettle(id, flags);
      } else if (sub === "delete") {
        if (!id) fail("사용법: yb engagement delete <id>");
        printJson(await request("DELETE", `/api/engagements/${id}`));
      } else fail("사용법: yb engagement get|update|settle|delete");
      return;
    }

    case "edu": {
      if (sub === "board") {
        const query = {};
        if (flags.stage !== undefined) query.stage = String(flags.stage);
        if (flags.q !== undefined) query.q = String(flags.q);
        // '완료' 프로젝트는 기본 필터(status 완료·보류·중단·무산 제외)에 걸리므로 완료 탭은 전체 조회로
        if (flags.all || flags.stage === "완료") query.include_all = "true";
        const res = await request("GET", "/api/education/board", { query });
        if (flags.json) {
          printJson(res);
          return;
        }
        renderEduBoard(res?.data);
      } else {
        fail("사용법: yb edu board [--stage 문의|제안|계약|커리큘럼|자료|운영|정산|회고|완료] [--q 검색어] [--all] [--json]");
      }
      return;
    }

    case "share": {
      const id = positional[1];
      if (sub === "create") {
        if (!flags.project) fail("사용법: yb share create --project <26-NNN|id> [--audience client] | [--instructor <이름|id>] | [--engagement <engagement id>] [--expires-at ISO]");
        const body = {};
        if (flags.audience !== undefined) body.audience = String(flags.audience);
        if (flags.instructor !== undefined) body.instructor = String(flags.instructor);
        if (flags.engagement !== undefined) body.engagement_id = String(flags.engagement);
        if (flags["expires-at"] !== undefined) body.expires_at = String(flags["expires-at"]);
        printJson(await request("POST", `/api/projects/${encodeURIComponent(String(flags.project))}/shares`, { body }));
      } else if (sub === "list") {
        if (!flags.project) fail("사용법: yb share list --project <26-NNN|id>");
        printJson(await request("GET", `/api/projects/${encodeURIComponent(String(flags.project))}/shares`));
      } else if (sub === "revoke") {
        if (!id) fail("사용법: yb share revoke <share id>");
        printJson(await request("POST", `/api/shares/${id}/revoke`));
      } else fail("사용법: yb share create|list|revoke");
      return;
    }

    case "submission": {
      const id = positional[1];
      if (sub === "list") {
        if (!flags.project) fail("사용법: yb submission list --project <26-NNN|id>");
        printJson(await request("GET", `/api/projects/${encodeURIComponent(String(flags.project))}/submissions`));
      } else if (sub === "request") {
        if (!flags.engagement) fail("사용법: yb submission request --engagement <engagement id> [--kind 커리큘럼|강의자료|프로필|기타] [--title 제목] [--due YYYY-MM-DD] [--note]");
        printJson(await request("POST", `/api/engagements/${String(flags.engagement)}/submissions`, { body: buildBody(flags, SUBMISSION_FIELDS) }));
      } else if (sub === "update") {
        if (!id) fail("사용법: yb submission update <id> [--status 요청됨|제출|승인|반려] [--due] [--note] [--drive-url]");
        printJson(await request("PATCH", `/api/submissions/${id}`, { body: buildBody(flags, SUBMISSION_FIELDS) }));
      } else fail("사용법: yb submission list|request|update");
      return;
    }

    default:
      fail(`알 수 없는 명령: ${command}. 'yb help' 참조`);
  }
}

main().catch((error) => fail(error.message));

// 플랫폼 로직 유닛 테스트용 export (CLI 실행에는 영향 없음 — 위에서 main 이 이미 구동된다).
