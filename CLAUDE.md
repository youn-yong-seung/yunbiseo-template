# 윤비서 템플릿 — 프로젝트 안내 (Claude Code 용)

자연어로 사내 업무를 다루는 AI 비서형 업무관리 시스템(Next.js 16 + Supabase)의 학습용 템플릿입니다.
처음 클론한 사용자는 대부분 초보자입니다. 친절하게, 한 번에 한 단계씩 안내하세요.

---

## 🚀 초기 설정 도우미

**트리거:** 사용자가 "초기 설정 도와줘", "설치 도와줘", "설치해줘", "세팅 도와줘", "처음부터 같이 해줘",
"setup", 또는 **GitHub 주소만 주며 "설치해줘"** 라고 하면 **아래 절차를 순서대로 진행**한다.
(사람용 상세본: `SETUP.md`)

### 진행 원칙
- **한 번에 한 단계.** 각 단계를 실행/안내하고, 결과를 확인한 뒤 다음으로 넘어간다. 한꺼번에 쏟아내지 않는다.
- **OS 를 먼저 파악한다.** Windows 와 macOS 는 설치 명령이 다르다(`winget` vs Homebrew/설치파일, `copy` vs `cp`).
  현재 OS 를 확인하고 그에 맞는 명령만 안내한다. 모르면 사용자에게 묻는다.
- **OS 레벨 설치는 대화형일 수 있음을 인지한다.** git·Node 설치는 UAC(윈도우) 승인 클릭이나 설치 마법사(맥)가
  뜰 수 있어 **클로드코드가 100% 무인 자동화할 수 없다.** 이 구간은 명령을 `!` 로 띄워 주고, 사용자가
  팝업을 승인/완료하도록 또렷이 안내한 뒤 결과를 확인한다. 그 다음 단계(supabase CLI~)부터는 네가 자동 처리한다.
- **⚠️ 새로 설치한 명령은 현재 세션에서 바로 안 잡힌다(특히 Windows).** winget/npm 등으로 supabase CLI 를
  방금 깔면 **이미 떠 있는 터미널·Claude Code 세션은 PATH 가 갱신되지 않아** 같은 창에서 `! supabase ...` 하면
  `command not found`/`...은(는) 인식되지 않습니다` 가 난다. 이때 **재시작을 시키지 말고, 네가 직접 설치 경로를 찾아
  완성된 명령을 사용자에게 바로 제시한다.** 절차(전부 네가 한다 — 사용자에게 경로를 묻거나 조립시키지 않는다):
  1. 네가 `npm prefix -g` 를 실행해 prefix 를 알아낸다(npm 은 보통 같은 세션에서 동작한다).
  2. supabase 풀패스를 만든다 — **Windows:** `<prefix>\supabase.cmd`, **macOS/Linux:** `<prefix>/bin/supabase`.
  3. 네가 `"<풀패스>" --version` 으로 실제로 실행되는지 확인한다.
  4. 이후 **비대화형 supabase 명령(`projects list`/`api-keys`/`db push`/`link` 등)은 네가 그 풀패스로 직접 실행**한다.
     예: `"C:\Users\실제계정\AppData\Roaming\npm\supabase.cmd" projects list -o json` (경로는 실측값으로).
  - **단, `supabase login` 은 예외(아래 ⚠️ 참고) — 풀패스로 `!` 에 넣지 말 것.** 그건 브라우저가 안 열리고 토큰 모드로 빠진다.
  - (풀패스로도 안 되는 예외 상황에서만) VS Code/터미널 재시작 → `claude` 재실행 → "이어서 설치해줘" 를 폴백으로 안내한다.
- **⚠️ `supabase login` 은 반드시 사용자가 "새/일반 터미널"에서 직접 실행한다 — `!` 로 시키지 않는다.**
  `login` 은 브라우저를 여는 **대화형** 명령인데, Claude Code 의 `!`(비대화형/에이전트 환경)에서 실행하면 CLI 가 이를 감지해
  **브라우저 대신 "액세스 토큰을 입력하라"** 는 모드로 빠진다(초보자가 여기서 막힘). 그래서 로그인은 이렇게 안내한다:
  **"새 터미널(또는 cmd)을 열고 `supabase login` 을 직접 실행하세요 — 브라우저가 열려 인증됩니다."**
  (새 터미널은 PATH 도 갱신돼 있어 `supabase` 가 바로 잡힌다.) 인증이 끝나면 토큰이 저장되어, 이후 비대화형 명령은
  네가 같은 머신에서 풀패스로 이어서 처리할 수 있다.
- **그 밖의 대화형 입력**(DB 비밀번호 등)도 사용자가 직접 실행하게 한다. `! 명령어` 는 이 세션에서 실행되지만,
  **브라우저·대화형 프롬프트가 필요한 명령(특히 `login`)은 `!` 가 아니라 사용자의 실제 터미널**에서 돌려야 한다.
- **비밀키**는 사용자가 채팅에 붙여넣으면 네가 `.env.local` 에 적어준다. 키 값을 채팅에 도로 출력하지 않는다.
- **에러가 나면** 메시지를 그대로 읽고, 원인과 해결책을 한국어로 쉽게 설명한 뒤 다시 시도한다.
- 진행 상황을 짧게 요약해 사용자가 지금 어디쯤인지 알게 한다.

### 단계
> **핵심 방침:** 대시보드에서 키를 손으로 복사하게 하지 않는다. **supabase CLI 로 로그인→프로젝트 생성→키 조회까지
> 자동화**해서, 사용자는 브라우저 로그인과 DB 비밀번호 입력만 하면 되게 한다. 이것이 가장 빠른 설치 경로다.

0. **환경 부트스트랩 (필수 프로그램 확인·설치)** — 이 과정은 **CLI-first** 다: GitHub·Supabase·Vercel 을
   전부 CLI 로 다루므로 처음에 5가지를 한 번에 깐다: **git**(코드 받기), **Node.js 20.9 이상 + npm**(빌드·실행),
   **GitHub CLI(gh)**(내 저장소 생성·push), **supabase CLI**(DB), **vercel CLI**(배포). 먼저 한 번에 점검한다:
   `git --version`, `node -v`, `npm -v`, `gh --version`, `supabase --version`, `vercel --version`. 없는 것만 OS 에 맞춰 깐다.
   - **Windows** (대부분 `winget` 사용 가능):
     - git: `winget install --id Git.Git -e`
     - Node LTS: `winget install --id OpenJS.NodeJS.LTS -e`  ← Node 가 npm·supabase/vercel CLI 의 전제
     - GitHub CLI: `winget install --id GitHub.cli -e`
     - (winget 자체가 없으면 https://nodejs.org LTS, https://git-scm.com 설치파일 안내)
   - **macOS**:
     - git: `git --version` 을 한 번 실행하면 Xcode Command Line Tools 설치창이 뜬다(또는 `xcode-select --install`).
     - Node LTS: Homebrew 가 있으면 `brew install node`, 없으면 https://nodejs.org LTS 설치파일 안내.
     - GitHub CLI: `brew install gh` (Homebrew 없으면 https://cli.github.com 설치파일).
   - **supabase CLI + vercel CLI** (git·Node 가 준비된 뒤): `npm install -g supabase vercel` —
     **Windows/macOS 모두 동작**한다. (macOS 는 `brew install supabase/tap/supabase` 도 가능.)
     이 흐름은 CLI 로 저장소 생성·프로젝트 생성·키 조회·배포까지 자동화하므로 CLI 설치가 **필수**다.
   - 사용자가 "로컬 실행만 빠르게" 원하면 gh·vercel 은 건너뛰어도 된다(각각 내 저장소 단계·배포 단계에서 다시 안내).
   - git·Node 설치는 승인 팝업/마법사가 뜰 수 있다 → `!` 로 명령을 띄우고 사용자가 완료하게 한 뒤 버전을 재확인한다.
   - **설치 직후 `--version` 으로 인식되는지 꼭 확인한다.** Windows 에서 방금 깐 supabase 가 `command not found`/
     `인식되지 않습니다` 로 안 잡히면 PATH 미갱신 문제다 → **재시작 시키지 말고, 네가 `npm prefix -g` 로 경로를 찾아
     `<prefix>\supabase.cmd` 풀패스로 비대화형 명령(`--version`/`projects list` 등)을 직접 실행**한다(위 진행 원칙 ⚠️ 절차).
     단 **`login` 은 풀패스 `!` 로 하지 말고** 사용자가 새 터미널에서 `supabase login` 을 직접 실행하게 한다(브라우저 필요).
1. **코드 받기 (URL 만 받은 경우)** — 이미 이 폴더가 열려 있으면(= `package.json` 이 보이면) 건너뛰고
   `npm install` 로 넘어간다. GitHub 주소만 받았다면 **지금 열려 있는 폴더가 비어 있는지 먼저 확인**한다.
   - **비어 있으면(수강생의 기본 경로) 현재 폴더에 그대로 받는다:**
     `git clone https://github.com/youn-yong-seung/yunbiseo-template.git .` ← **끝의 점을 빠뜨리지 않는다.**
     사용자가 만든 폴더(예: `우리회사-시스템`)가 곧 프로젝트 루트가 되어야 한다. 하위에 `yunbiseo-template/`
     같은 폴더를 한 겹 더 만들면 **폴더 이름이 사람마다 달라지고, 1-2단계의 저장소 이름까지 원본과 같아져**
     수업 진행과 안내가 어긋난다.
   - **비어 있지 않으면** 충돌하므로 하위 폴더로 받는다: `git clone <url> my-secretary` 후 그 폴더로 이동한다.
   - 어느 쪽이든 클론이 끝나면 프로젝트 루트에서 `npm install` 을 실행한다.
1-2. **내 GitHub 저장소 만들기 (권장, 건너뛰기 가능)** — 커스텀 내역을 백업하고 과제 인증·Vercel 연동에 쓸
   **사용자 소유 비공개 저장소**를 만든다. 순서:
   - `gh auth status` 로 로그인 확인. 미로그인이면 **사용자가 새 터미널에서 `gh auth login` 을 직접 실행**하게
     안내한다(브라우저 인증 — `supabase login` 과 같은 이유로 `!` 비대화형에서 돌리면 안 된다.
     프롬프트는 GitHub.com → HTTPS → Login with a web browser 선택 안내).
   - 로그인 확인 후 **네가 직접** 실행한다: `git remote rename origin template` →
     `gh repo create <폴더명> --private --source=. --push`. 이름 충돌 시 다른 이름을 제안한다.
     **`<폴더명>` 이 `yunbiseo-template` 이면(= 1단계에서 점 없이 클론된 경우) 그대로 쓰지 말고**
     사용자에게 회사 이름을 넣은 저장소 이름을 제안해 확인받는다. 원본과 같은 이름은 나중에 본인 저장소인지
     템플릿인지 구분이 안 된다.
   - ⚠️ **저장소 이름은 영문 소문자·숫자·하이픈으로 정한다**(예: `mirae-system`). 폴더명이 한글이면
     GitHub 은 받아주지만 URL 이 퍼센트 인코딩으로 길어지고, **무엇보다 나중에 Vercel 배포에서 프로젝트
     이름으로 재사용할 수 없다**(아래 배포 도우미 3단계 참고). 폴더명이 한글이면 영문 이름을 제안해 확인받는다.
   - 완료 후 origin=내 저장소, template=원본임을 알려주고, 이후 작업 커밋은 `git push` 로 백업됨을 안내한다.
   - 사용자가 원치 않거나 GitHub 계정이 없으면 건너뛴다(나중에 "내 GitHub 저장소 만들어줘" 로 재개).
2. **Supabase 로그인 (사용자가 새 터미널에서 직접)** — **`!` 로 시키지 말고**, 사용자에게
   **"새 터미널(또는 cmd)을 열어 `supabase login` 을 직접 실행"** 하라고 안내한다. 브라우저가 열려 인증하면
   토큰이 자동 저장된다(대시보드 접속·키 복사 불필요). ⚠️ `! supabase login`(비대화형)으로 하면 브라우저 대신
   토큰 입력 모드로 빠져 막히므로 쓰지 않는다. 인증 완료 후(네가 `supabase projects list` 풀패스 등으로 확인) 다음 단계로.
3. **프로젝트 준비** — 로그인 후 네가 직접 명령으로 처리한다. 두 갈래 중 하나:
   - **새로 만들기(기본):** **DB 비밀번호는 사용자에게 묻지 말고 네가 강력하게 생성한다.**
     `node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"` 같은 방식으로 특수문자 없는
     안전한 값을 만들고, **이 비밀번호를 즉시 `.env.local` 의 `SUPABASE_DB_PASSWORD=` 에 저장**한다(채팅에 출력하지 않음).
     `supabase orgs list -o json` 으로 조직 ID 를 확인하고(여러 개면 사용자가 고르게 한다), 리전은 `ap-northeast-2`(서울)
     기본으로, **네가 직접** 생성한다(사용자에게 실행시키지 않는다):
     `supabase projects create "yun-secretary" --org-id <org> --db-password <생성한비밀번호> --region ap-northeast-2 -o json`
   - **기존 프로젝트 사용:** `supabase projects list -o json` 결과를 보여주고 쓸 프로젝트를 고르게 한다.
     (이 경우 DB 비밀번호는 네가 모르므로, `link` 단계에서 사용자에게 한 번 입력받아 `.env.local` 에 저장한다.)
   - 어느 쪽이든 결과에서 **project ref**(`<ref>`)를 확보한다. 새 프로젝트는 준비에 1~2분 걸릴 수 있어
     `ACTIVE_HEALTHY` 가 될 때까지 `supabase projects list -o json` 으로 상태를 확인한 뒤 다음으로 넘어간다.
4. **키 자동 조회 & `.env.local` 작성** — 네가 직접 처리한다(사용자가 키를 복사할 필요 없음):
   - `supabase projects api-keys --project-ref <ref> -o json` 으로 `anon` 과 `service_role` 키를 받는다.
   - `cp .env.example .env.local`(Windows cmd 면 `copy`) 후 다음을 채운다:
     `NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon>`,
     `SUPABASE_SERVICE_ROLE_KEY=<service_role>`, 그리고 **`SUPABASE_DB_PASSWORD=<3단계에서 생성한 비밀번호>`**.
     `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` 은 기본값(example.com) 유지.
   - service_role·DB 비밀번호는 비밀값이므로 채팅에 값을 다시 출력하지 않는다(`.env.local` 에만 저장).
5. **연결 & DB 생성** — 비밀번호를 네가 갖고 있으므로 **사용자 개입 없이 네가 직접** 실행한다:
   - `supabase link --project-ref <ref> -p <SUPABASE_DB_PASSWORD>` (3·4단계에서 저장한 값을 그대로 사용).
   - 이어서 `supabase db push --yes` 를 실행한다(`--yes` 로 확인 프롬프트 자동 통과). 테이블 30개와 정책이 생성된다.
   - (기존 프로젝트를 골랐고 비밀번호를 모르면) 이때만 사용자에게 한 번 입력받아 `.env.local` 에 저장한 뒤 진행한다.
   - `project not ready`/연결 오류면 프로젝트 준비(1~2분)를 기다렸다가, 또는 login/link 를 재확인 후 재시도한다.
6. **첫 관리자 생성** — 이 앱은 **회원가입 화면이 없다.** 로그인 계정은 이 단계로 만드는 관리자 1개로 시작한다.
   `npm run setup:admin` 을 실행하면 ID `admin` 과 **무작위 비밀번호**(예: `jadong-k7m2-x9qp`)가 만들어지고 한 번만 출력된다.
   이 비밀번호는 사용자가 로그인에 써야 하므로 **사용자에게 그대로 알려 주고 메모하라고 안내한다**(공개 저장소에 적힌 고정
   비밀번호는 쓰지 않는다 — 배포본에 누구나 관리자로 들어오는 문제가 있었다). (직원 추가는 로그인 후 [직원관리] 화면에서.)
7. **실행 & 로그인** — `npm run dev` 를 백그라운드로 띄운다.
   http://localhost:3000 에서 **이메일이 아니라 ID `admin`** 과 6단계 비밀번호로 로그인하라고 알린다.
   로그인 직후 **왼쪽 사이드바 맨 아래 '내 이름' 클릭 → 마이페이지(`/dashboard/my`)에서 비밀번호를 꼭 바꾸라고** 안내한다.
8. **완료** — 축하 인사와 함께, 회사정보·외부연동(Gemini/Bolta/Slack)은 **선택(심화)** 이며
   `SETUP.md` 6장 또는 [시스템설정] 화면에서 나중에 켤 수 있다고 알린다.
   인터넷 배포를 원하면 **"배포해줘"** 라고 하면 된다고 안내한다(아래 배포 도우미).

---

## 🚀 배포 도우미 (Vercel)

**트리거:** "배포해줘", "배포하고 싶어", "vercel 배포", "인터넷에 올려줘", `/deploy` → 아래 절차를 진행한다.
로컬 설치(위 초기 설정)가 끝난 상태를 전제로 한다.

1. **로그인 확인** — `vercel whoami` 실행. 미로그인이면 **사용자가 새 터미널에서 `vercel login` 을 직접 실행**하게
   안내한다(브라우저 인증 — `supabase login`/`gh auth login` 과 같은 이유로 `!` 비대화형 금지).
2. **비밀번호·가입 점검** — 배포하면 URL 을 아는 누구나 로그인 화면에 접근한다. 관리자 비밀번호를 남과 공유했다면
   **배포 전에 마이페이지에서 변경**하도록 안내한다. Supabase 대시보드 → Authentication → Sign In / Providers →
   "Allow new users to sign up" 끄기도 권한다(직원이 아닌 계정은 서버·DB 정책이 막지만 한 겹 더 막는다).
3. **프로젝트 연결** — `vercel link --yes` 를 네가 실행한다(첫 실행 시 폴더명으로 프로젝트 자동 생성).
   ⚠️ **Vercel 프로젝트 이름은 소문자 영숫자와 `.` `_` `-` 만 허용된다.** 폴더 이름이 한글이거나 대문자·공백을
   포함하면 `invalid_project_name` 으로 실패한다(수강생 폴더명이 `우리회사-시스템` 같은 경우가 흔하다).
   **먼저 폴더명을 확인하고, 규칙에 안 맞으면 ASCII 이름을 만들어 명시적으로 지정한다:**
   `vercel link --yes --project <ascii-이름>` (예: `mirae-system`). 사용자에게 그 이름을 알려준다 —
   배포 URL 이 `https://<ascii-이름>.vercel.app` 이 된다. 폴더 이름 자체를 바꿀 필요는 없다.
4. **환경변수 등록** — `.env.local` 에서 값을 읽어 **네가 직접** 등록한다. 값은 채팅에 출력하지 않는다:
   `printf '%s' "<값>" | vercel env add <KEY> production` 방식(비대화형)으로
   `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` /
   `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN` 4개를 넣는다. 이미 존재하는 키는 `vercel env rm <KEY> production -y` 후 재등록.
   (`.env.local` 에 Gemini 등 선택 키가 채워져 있으면 함께 등록할지 물어본다.)
5. **배포** — `vercel deploy --prod --yes` 를 실행하고 출력된 프로덕션 URL 을 확인한다.
   빌드 실패 시 로그를 읽고 원인(대부분 env 누락)을 고쳐 재배포한다.
6. **검증·마무리** — 배포 URL 을 `curl` 로 200 확인 후 사용자에게 알린다. 함께 안내할 것:
   - 로컬과 배포본은 **같은 Supabase DB** 를 본다(데이터 동일).
   - 코드 수정 후엔 "다시 배포해줘" 한마디면 된다(`vercel deploy --prod --yes`).
   - Slack 웹훅 등 콜백을 쓰면 `NEXT_PUBLIC_APP_URL` 을 배포 URL 로 추가 등록 후 재배포.
   - 기본 크론(매일 Slack 일정 알림)은 Hobby 플랜에서 동작하며 `CRON_SECRET` 등록이 필요하다.
     분 단위 리마인더·반복매입 크론은 Pro 플랜에서 `vercel.json` 의 `crons` 에 추가한다.

### 자주 나는 문제
- **`supabase` 가 방금 설치했는데 `command not found`/`인식되지 않습니다`(특히 Windows)** →
  현재 세션 PATH 미갱신 문제다. **재시작 시키지 말고 네가 경로를 찾아 비대화형 명령은 풀패스로 직접 실행:**
  `npm prefix -g` → `<prefix>\supabase.cmd`(Windows)/`<prefix>/bin/supabase`(mac) → `"<풀패스>" --version` 확인 →
  이후 `projects list`/`api-keys`/`db push` 등은 풀패스로 네가 실행. (단 `login` 은 풀패스 `!` 로 하지 말 것 — 아래 항목)
- **`supabase login` 했더니 브라우저 대신 "토큰을 입력하라"고 나옴** → `login` 을 비대화형(`!`/풀패스 `!`)에서 돌려서다.
  **사용자가 새 터미널(또는 cmd)을 열어 `supabase login` 을 직접 실행**하게 하면 브라우저가 열린다(새 터미널은 PATH 도 해결).
- `supabase projects create`/`api-keys` 가 인증 오류 → 사용자가 **새 터미널에서 `supabase login`** 을 먼저 했는지 확인.
- `supabase db push` 가 `project not ready`/연결 오류 → 새 프로젝트 준비(1~2분)를 기다린 뒤,
  `supabase link --project-ref <ref>` (DB 비밀번호) 를 재확인하고 재시도.
- `npm run build` 실패 → `.env.local` 의 Supabase 값(URL/anon/service_role)이 채워졌는지 확인 (빌드에 필요).
- `setup:admin` 이 비밀번호 길이 오류 → 직접 줄 때는 **10자 이상**. 비워 두면 무작위로 만든다.
- 로그인 안 됨 → ① 이메일이 아니라 **ID(`admin`)** 로 시도했는지 확인, ② `npm run setup:admin` 을 다시 실행해 새 비밀번호를 받는다.
  "15분 동안 로그인할 수 없습니다" 는 5번 틀려 잠긴 것이다(15분 뒤 풀림, 계정이 비활성화되지는 않는다).
- **`gh auth login`/`vercel login` 이 브라우저를 안 열고 코드/토큰을 요구** → 비대화형(`!`)에서 돌려서다.
  supabase 와 동일하게 **사용자가 새 터미널에서 직접** 실행하게 한다. (`gh` 는 device code 가 떠도 브라우저에서
  코드 입력으로 진행 가능하니, 뜨면 그 코드를 안내한다.)
- `gh repo create` 가 "Name already exists" → 다른 저장소 이름을 제안해 재시도.
- `vercel env add` 가 값 입력 프롬프트에서 멈춤 → 대화형이라서다. `printf '%s' "<값>" | vercel env add <KEY> production` 으로 파이프해 비대화형으로 실행한다.
- Vercel 배포는 됐는데 화면이 에러 → 환경변수 4개가 production 에 등록됐는지 `vercel env ls` 로 확인 후 재배포.

---

## 🤖 윤비서 CLI(yb) 설치 도우미

**트리거:** "윤비서 CLI 설치해줘", "yb 설치해줘", "AI 앱이랑 윤비서 연결해줘", "윤비서 연결해줘", `/yb-setup`.
사람용 안내서는 `docs/YB_CLI_START.md` 다. 이 절차가 AI 용 정본이다(Codex 는 `AGENTS.md` 가 여기를 가리킨다).

### 진행 원칙
- 사용자는 대부분 비개발자다. 한 번에 한 단계, 쉬운 말로, 결과를 확인하고 넘어간다.
- **API 키·비밀번호를 채팅에 다시 출력하지 않는다.** 출력에 키가 섞이면 앞 8자만 보인다.
- **`yb login` 은 연결할 때 딱 한 번만** 실행한다(브라우저가 뜬다). 그 뒤로 "나"는 항상 `yb whoami` 로 확인한다.
  `whoami` 가 실패해도 `yb login` 을 반복하지 말고 원인을 알려 준다.

### 단계
1. **Node 확인** — `node -v` 가 v18 이상이면 통과. 없으면 OS 에 맞춰 설치를 안내한다
   (Windows `winget install --id OpenJS.NodeJS.LTS -e`, macOS `brew install node` 또는 https://nodejs.org LTS).
   설치 직후 같은 창에서 안 잡히면 초기 설정 도우미의 PATH 처리와 같은 방식으로 풀패스를 쓴다.
2. **yb 설치** — 둘 중 하나.
   - 지금 폴더가 윤비서 저장소면(`package.json` 의 name 이 `yun-secretary-template`, `tools/yb.mjs` 있음): `npm link`.
     권한 오류면 `npm run yb -- <명령>` 으로 대신 쓴다.
   - 저장소가 없으면(강사·테스트 환경): 파일 하나만 받는다.
     - macOS/Linux: `mkdir -p ~/.yb ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/youn-yong-seung/yunbiseo-template/main/tools/yb.mjs -o ~/.yb/yb.mjs && printf '#!/bin/sh\nexec node "$HOME/.yb/yb.mjs" "$@"\n' > ~/.local/bin/yb && chmod +x ~/.local/bin/yb`
       (`~/.local/bin` 이 PATH 에 없으면 `node ~/.yb/yb.mjs` 로 부른다.)
     - Windows(PowerShell): `New-Item -ItemType Directory -Force $HOME\.yb | Out-Null; Invoke-WebRequest https://raw.githubusercontent.com/youn-yong-seung/yunbiseo-template/main/tools/yb.mjs -OutFile $HOME\.yb\yb.mjs`
       이후 `node $HOME\.yb\yb.mjs <명령>` 으로 부른다.
   - 확인: `yb version` (또는 `node ~/.yb/yb.mjs version`).
3. **주소·키 받기** — 윤비서 주소를 묻는다(예: `https://우리회사.vercel.app`, 로컬이면 `http://localhost:3000`).
   키는 사용자가 이미 줬으면 그걸 쓰고, 없으면 두 길을 제안한다.
   - 키 방식: "윤비서 로그인 → 왼쪽 사이드바 맨 아래 '내 이름' → 마이페이지 → '내 API 키' → [새 API 키 만들기] → 복사" 를 안내.
   - 브라우저 방식(키를 채팅에 안 붙임): `yb login --url <주소>` 를 **한 번** 실행하고(최대 5분 대기, 타임아웃 넉넉히),
     사용자에게 열린 브라우저에서 로그인 후 **[이 컴퓨터에서 yb CLI 인증]** 을 누르라고 한다.
4. **연결** — 키 방식이면 `yb auth --key <키> --url <주소>`. 이 명령이 서버에 키 주인을 확인하고, 틀리면 저장하지 않는다.
5. **확인** — `yb whoami` 결과의 `employee`(이름)를 사용자에게 알려 준다. 이어서 `yb today` 를 보여 주며 끝낸다.
6. **안내** — "이제 '오늘 일정 알려줘', '다음 주 화요일 2시 미팅 추가해줘' 처럼 말하면 된다"고 알리고,
   `docs/YB_CLI_START.md` 3단계 표를 짧게 보여 준다.

### 연결된 뒤 말 → 명령 (모든 출력은 JSON 이니 사람 말로 요약해서 답한다)
- 오늘 일정·할 일: `yb today` (내 열린 할 일 + 오늘 내 일정).
- 기간 일정: `yb schedule list --from <날짜> --to <날짜> --assignee me`. 날짜는 `YYYY-MM-DD`·`오늘`·`내일`·`금`·`"다음주 화"`·`11-25`.
- 일정 추가: `yb schedule create --title "<제목>" --date "<날짜>" --time HH:MM [--duration-min 60] [--location] [--category meeting]`.
  **시각을 모르면 추측하지 말고 묻는다.** 미팅이면 `--category meeting`. 담당자를 안 주면 나(키 주인)가 담당자다.
- 일정 수정·삭제: 먼저 `schedule list` 로 id 를 찾고 `yb schedule update <id> ...` / `yb schedule delete <id>`. 삭제는 한 번 확인받는다.
- 매출 등록: `yb revenue create --title "<내용>" --total <부가세 포함 총액> [--project 26-3] [--date YYYY-MM-DD]`.
  공급가만 들었으면 총액(×1.1)인지 확인한다.
- 고객 전화번호: `yb customer get <고객 이름>` → `contact_phone`, 담당자는 `contacts[]`.
- 세금계산서 상태: `yb revenue list --q <검색어>` 로 매출 id 를 찾고 `yb revenue tax-invoice status <매출id>`.
  `taxInvoiceState`(not_issued/issuing/issued/failed)와 `blockedReasons` 를 쉬운 말로 전한다.
  **발행(`issue --yes`)은 외부 발행이다. 미리보기를 보여 주고 사용자가 "발행해"라고 한 뒤에만 한다.**
- 할 일: `yb give <담당자|나> "<지시>" --due <언제>`, `yb done <번호> --note "<결과>"`, `yb given`.
- 쓸 수 있는 명령 전체: `yb help`.

### 자주 나는 문제
- `yb auth --key` 가 "연결하지 못했습니다" → 주소 오타(끝의 `/`·`http/https`), 키 일부만 복사, 서버 꺼짐(`localhost` 면 `npm run dev`) 순서로 본다.
- `HTTP 401` → 키가 지워졌거나 직원 계정이 비활성. 새 키를 만들게 안내한다. 관리자에게 계정 상태 확인.
- `HTTP 403` → 권한 밖(남이 만든 일정·할 일 수정, 관리자 전용 기능). 우회하지 말고 사용자에게 그대로 알린다.
- "수강생판에서는 아직 지원하지 않는 명령" → 템플릿에 없는 기능이다. `yb help` 범위 안에서 한다.

---

## 📱 법인카드 문자 연동 도우미

**트리거:** "카드 문자 연동 도와줘", "법인카드 연동", "폰 연결했어 설정해줘", "카드 문자 받게 해줘".
`docs/CARD_SMS_SETUP.md` 를 읽고 맨 아래 **(Claude Code 용) 진행 절차**를 한 단계씩 따른다.
폰 화면 조작은 대신할 수 없으니 화면 이름 그대로 안내하고, 서버 확인·시험·결과 확인은 네가 직접 한다.

---

## 포함 기능 (메뉴)

워크스페이스 · 고객관리 · 프로젝트관리 · 할일관리 · 일정관리 · 미팅관리 · 견적관리 ·
매출관리 · 입금관리 · 매입관리 · 법인카드 · 영업이익분석 · 직원관리 · 시스템설정 · 마이페이지(내 API 키)

## 🔐 보안 규칙 (코드를 고칠 때 지킬 것)

- 누가 무엇을 볼 수 있는지의 기준은 `supabase/migrations/20261118000000_security_hardening.sql` 머리말과 같다.
  회사 공용 데이터(고객·프로젝트·매출 등)는 **활성 직원**만, 할 일·일정·메모 수정은 만든 사람·담당자·관리자만,
  직원 관리·시스템 설정·남의 API 키는 관리자만, API 키·구글 토큰·외부 서비스 키는 서버만 다룬다.
- 새 API 라우트는 첫 줄에서 `requireRouteUser` / `requireRouteAdmin` / `requireRouteUserOrApiKey`(`src/lib/route-auth.ts`)로 막는다.
  `createAdminClient()`(service role, RLS 우회)는 그 확인을 통과한 뒤에만 쓴다.
- 새 테이블은 같은 사이클에서 RLS 를 켜고 정책을 만든다(`public.is_active_employee()` 등 판정 함수 사용). anon 에는 권한을 주지 않는다.
- cron·웹훅은 비밀이 없으면 거부한다(`verifyCronSecret`). 응답에 DB 오류 원문을 싣지 않는다(`publicErrorMessage`, `dbError`).

> 회사 정보(상호/대표자/사업자번호/계좌)는 비어 있다. 견적서를 쓰려면
> `src/lib/quotation-constants.ts` 에서 값을 채운다.
> Google(메일/캘린더/드라이브)·세금계산서(Bolta)·Slack 코드는 기본 비활성이며 키를 넣으면 동작한다.

---

## Project Conventions

### Git Rules
- 커밋 메시지는 한국어로 작성한다. 화면명·기능명·변경 목적을 구체적으로 적는다.
  예: `프로젝트관리 일정 요일 표기 추가`, `고객관리 담당자 상세보기 추가`
- 작업이 끝나면 즉시 커밋한다. 미커밋 상태로 작업을 종료하지 않는다.
- push와 배포는 사용자가 명시적으로 요청할 때만 수행한다.
- 하나의 커밋에는 하나의 목적(기능, 버그 수정, 리팩터링)만 담는다.

### Supabase 마이그레이션
- 최초 설치는 위 "초기 설정 도우미" 또는 `SETUP.md` 를 따른다.
- 스키마를 바꾸면 `supabase/migrations/` 에 새 마이그레이션 파일을 만들고 `supabase db push` 로 적용한다.
- DB 스키마를 바꾸는 코드(컬럼 신규/삭제, 제약 변경 등)는 항상 마이그레이션 + 적용까지 한 사이클로 끝낸다.

### Font
- Pretendard만 사용한다. Geist, Inter 등 다른 폰트를 추가하지 않는다.

### UI Pattern: List -> Detail Page
- 목록 행 클릭 → 상세 페이지 이동. 목록에 수정/삭제 버튼 노출하지 않는다.
- 등록은 목록에서, 수정은 별도 편집 페이지(`/[id]/edit/page.tsx`)를 사용한다.
- 상세 페이지 브레드크럼: `{리소스명} / {항목명}`. 상단 헤더에 수정·삭제·주요 액션 배치.
- 삭제는 `confirm()` 이후 목록으로 이동한다.

### UI Pattern: StatCard 모바일
- 모바일: 라벨과 값만 표시. 아이콘·설명글은 `hidden md:flex` / `hidden md:block`으로 데스크톱 전용.
- 금액 StatCard는 `mobileValue` prop에 `formatAmountInMan()`으로 만 단위 표시.

### 메모 기능 공통 규칙
- 메모(추가/수정/삭제)는 프로젝트관리와 고객관리가 공유하는 기능이다. 한쪽을 수정하면 다른 쪽도 같이 수정한다.
- 상세 규칙은 `docs/MEMO_RULES.md` 참고.
