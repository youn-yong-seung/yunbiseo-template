// `npm run dev` 시작 시 로그인 안내를 보여주는 배너입니다. (package.json 의 predev 로 자동 실행)
// 비밀번호는 설치할 때 `npm run setup:admin` 이 무작위로 만들어 한 번만 보여 줍니다(고정 비밀번호 없음).

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m",
  cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m", gray: "\x1b[90m",
};

const line = "════════════════════════════════════════════";
console.log("");
console.log(C.cyan + line + C.reset);
console.log(C.cyan + "  🔑  " + C.bold + "윤비서 로그인" + C.reset);
console.log(C.cyan + "  ──────────────────────────────────────" + C.reset);
console.log("      👤  ID  :  " + C.bold + C.yellow + "admin" + C.reset + C.gray + "  (setup:admin 에서 다른 ID 를 정했다면 그 ID)" + C.reset);
console.log("      🔒  PW  :  " + C.bold + "npm run setup:admin 이 보여 준 비밀번호" + C.reset);
console.log(C.cyan + line + C.reset);
console.log("  🌐  " + C.green + "http://localhost:3000" + C.reset + " 에서 로그인하세요.");
console.log("  👉  비밀번호를 잊었으면 " + C.bold + "npm run setup:admin" + C.reset + " 을 다시 실행하면 새 비밀번호를 받습니다.");
console.log("");
