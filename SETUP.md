# 윤비서 템플릿 설치 가이드 (로컬 실행)

처음 설치하는 분도 **이 문서만 따라 하면** 내 컴퓨터에서 윤비서를 실행하고 로그인할 수 있습니다.
설치는 크게 6단계이고, 보통 **10~15분**이면 끝납니다.

## 전체 흐름 한눈에

```
0. 필요한 프로그램 설치 (git · Node.js · GitHub CLI · Supabase CLI · Vercel CLI)
1. 코드 받기 (git clone) + npm install + 내 GitHub 저장소 만들기 (gh)
2. Supabase 로그인 → 프로젝트 만들기
3. 키 조회 → .env.local 작성 → DB 테이블 생성 (db push)
4. 첫 관리자 계정 만들기 (setup:admin)   ← 회원가입 화면이 없으므로 이 단계로 로그인 계정을 만듭니다
5. 실행 (npm run dev) → http://localhost:3000 로그인
6. (선택) 외부 연동 켜기
7. (선택) Vercel 로 인터넷에 배포
```

> 💡 **왜 CLI 를 먼저 다 깔까요?** GitHub·Supabase·Vercel 은 전부 CLI(명령줄 도구)를 제공합니다.
> 처음에 CLI 3종을 설치해 두면 저장소 생성 → DB 프로젝트 생성·연결 → 배포까지 **전 과정을
> 브라우저 대시보드 없이 명령으로** 끝낼 수 있고, Claude Code 가 이 명령들을 대신 실행해 줍니다.

---

## ✨ 가장 쉬운 방법 — Claude Code 에게 맡기기

위 단계를 직접 안 하고 싶으면, **Claude Code 가 처음부터 끝까지 대신** 해 줍니다.

- **이미 이 폴더를 클론했다면:** 폴더를 Claude Code 로 열고
  > **"설치해줘"** (또는 `초기 설정 도와줘`, `/setup`)
- **아직 URL밖에 없다면:** Claude Code 에 이렇게 말하세요. 클론부터 알아서 합니다.
  > **"https://github.com/youn-yong-seung/yunbiseo-template 설치해줘"**

그러면 Claude 가 OS(Windows/맥)를 확인해 필요한 프로그램을 깔고, 클론·설치·DB 생성·관리자 계정까지
**한 단계씩 같이** 진행한 뒤, 마지막에 **로그인 ID 와 비밀번호**를 알려 줍니다.
(git·Node 설치 시 승인 팝업/마법사는 클릭 한두 번만 직접 해 주면 됩니다.)

> 막히면 언제든 **Claude Code 에게 에러 메시지를 그대로 붙여넣고** 물어보세요.
> 예: "SETUP.md 3단계 `supabase db push` 에서 에러가 났어. 같이 봐줘."

아래는 **직접(수동) 설치**하는 분을 위한 단계별 안내입니다.

---

## 0. 필요한 프로그램 (5가지)

| 필요한 것 | Windows | macOS |
|-----------|---------|-------|
| **git** (코드 받기) | `winget install --id Git.Git -e` | `git --version` 실행 → 설치창 뜨면 진행 (또는 `xcode-select --install`) |
| **Node.js 20.9+** (빌드·실행) | `winget install --id OpenJS.NodeJS.LTS -e` | `brew install node` / 없으면 [nodejs.org](https://nodejs.org) LTS |
| **GitHub CLI** (내 저장소 만들기) | `winget install --id GitHub.cli -e` | `brew install gh` |
| **Supabase CLI** (DB) | `npm install -g supabase` | `npm install -g supabase` (또는 `brew install supabase/tap/supabase`) |
| **Vercel CLI** (인터넷 배포) | `npm install -g vercel` | `npm install -g vercel` |

- 잘 깔렸는지 확인: `git --version`, `node -v`(v20.9 이상), `gh --version`, `supabase --version`, `vercel --version` 이 모두 버전을 출력하면 OK.
- `winget` 이 없으면(구형 Windows) [nodejs.org](https://nodejs.org)·[git-scm.com](https://git-scm.com) 에서 설치파일로 받으세요.
- Supabase CLI 와 Vercel CLI 는 **Node 를 먼저 깐 뒤** 설치됩니다(`npm` 이 필요).
- 계정 3개(모두 무료)가 필요합니다: **GitHub**(github.com) · **Supabase**(supabase.com) · **Vercel**(vercel.com, GitHub 계정으로 가입 가능).
  각 로그인은 필요한 단계에서 CLI 가 브라우저를 열어 처리합니다.
- 최소한으로 가려면 git·Node·Supabase CLI 3개만으로도 **로컬 실행까지는** 됩니다.
  GitHub CLI 는 내 저장소 백업·과제 인증(1단계), Vercel CLI 는 배포(7단계)에 쓰입니다.

> 💡 git·Node 설치는 승인 팝업(Windows UAC)이나 설치 마법사가 떠서 **클릭 한두 번은 직접** 해야 합니다.

> ⚠️ **Windows 필독 — 설치 직후 `supabase` 가 "인식되지 않습니다"로 나오면:**
> 방금 설치한 프로그램은 **이미 열려 있던 터미널·VS Code 창에는 즉시 반영되지 않습니다**(PATH 갱신 문제).
> 같은 창에서 계속 시도하지 말고, 아래 순서로 해결하세요. (Claude Code 로 하면 1번을 알아서 해 줍니다.)
> 1. **(가장 쉬움 — 재시작 불필요) 설치된 전체 경로로 실행.** 먼저 설치 위치를 확인합니다:
>    ```
>    npm prefix -g
>    ```
>    출력된 경로 뒤에 `\supabase.cmd` 를 붙여 그 **절대경로로** 명령을 실행하면 PATH 갱신 없이 바로 됩니다. 예:
>    ```
>    "C:\Users\내계정\AppData\Roaming\npm\supabase.cmd" --version
>    ```
>    ⚠️ 단 **`supabase login` 은 이렇게 하지 마세요.** login 은 브라우저가 필요한데 절대경로/Claude `!` 로 돌리면
>    브라우저 대신 "토큰을 입력하라"고 나옵니다. login 은 아래 2·3번처럼 **새 터미널에서 `supabase login`** 으로 하세요.
> 2. (권장 — 특히 login) **새 cmd(또는 터미널) 창을 따로 열어** 거기서 `supabase login` 을 실행하세요.
>    새 창은 PATH 도 갱신돼 있고 진짜 터미널이라 **브라우저가 바로 열립니다.**
> 3. (대안) **VS Code 를 완전히 종료했다가 다시 켜기** → 새 터미널에서 `supabase` 가 잡힙니다.
>    Claude Code 로 진행 중이었다면 재시작 후 `claude` 를 다시 실행하고 **"이어서 설치해줘"** 라고 하면 됩니다.

---

## 1. 코드 받기 & 내 저장소 만들기

```bash
git clone https://github.com/youn-yong-seung/yunbiseo-template.git my-secretary
cd my-secretary
npm install
```

> 이후 모든 명령은 **이 `my-secretary` 폴더 안에서** 실행합니다.

이어서 **내 GitHub 저장소(비공개)로 연결**합니다. 앞으로 커스텀한 내용을 커밋·백업하고,
과제 인증이나 Vercel 연동에도 쓰는 내 소유 저장소입니다.

```bash
# 1) GitHub 로그인 (처음 한 번, 브라우저가 열립니다 — 일반 터미널에서 실행)
gh auth login

# 2) 원본 템플릿 리모트는 'template' 라는 이름으로 남겨두고
git remote rename origin template

# 3) 내 계정에 비공개 저장소를 만들고 코드를 올립니다 (origin = 내 저장소)
gh repo create my-secretary --private --source=. --push
```

> - 이후 커밋은 `git push` 만 하면 **내 저장소**로 올라갑니다.
> - 원본 템플릿이 업데이트되면 `git pull template master` 로 받아올 수 있습니다.
> - 급하면 이 부분(내 저장소 만들기)은 건너뛰고 나중에 해도 됩니다 —
>   Claude Code 에게 **"내 GitHub 저장소 만들어줘"** 라고 하면 위 절차를 대신 해 줍니다.

---

## 2. Supabase 로그인 & 프로젝트 만들기 (CLI 로 한 번에)

대시보드에서 키를 손으로 복사할 필요 없이, **CLI 로 로그인 → 프로젝트 생성 → 키 조회**까지 끝냅니다.

> ⚠️ `supabase login` 은 **일반 터미널(또는 cmd)에서 직접** 실행하세요. 그래야 브라우저가 열립니다.
> Claude Code 안에서 `!` 로 실행하면 비대화형이라 브라우저 대신 **"토큰을 입력하라"** 고 나와서 막힙니다.

```bash
# 1) 로그인 (일반 터미널에서 실행 → 브라우저가 열려 인증합니다)
supabase login

# 2) 내 조직 ID 확인 (ID 열의 값을 복사)
supabase orgs list

# 3) 새 프로젝트 생성 — 비밀번호는 직접 정하고 꼭 메모하세요. 한국이면 리전은 ap-northeast-2(서울) 권장
#    (한 줄로 입력하세요 — Windows/맥 동일)
supabase projects create "yun-secretary" --org-id <조직-ID> --db-password <원하는-DB비밀번호> --region ap-northeast-2

# 4) 생성된 project ref 확인 (REFERENCE ID 열의 값을 복사)
supabase projects list
```

> 새 프로젝트는 준비에 **1~2분** 걸립니다. (이미 쓰던 빈 프로젝트가 있으면 3번을 건너뛰고 4번에서 ref 만 골라도 됩니다.)

---

## 3. 키 조회 & DB 만들기

```bash
# 1) 환경변수 파일 만들기   (Windows cmd 라면 'copy .env.example .env.local')
cp .env.example .env.local

# 2) anon / service_role 키 조회 (대시보드 복사 불필요)
supabase projects api-keys --project-ref <내-project-ref>
```

`.env.local` 을 열어 위에서 받은 값으로 아래 4줄을 채웁니다 (URL 은 `https://<ref>.supabase.co`):

```
NEXT_PUBLIC_SUPABASE_URL=https://<내-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon 키>
SUPABASE_SERVICE_ROLE_KEY=<service_role 키>     # 🔒 비밀값 — 외부 공유 금지
SUPABASE_DB_PASSWORD=<2단계에서 정한 DB 비밀번호>   # 🔒 재연결용 기록(앱은 사용 안 함)
NEXT_PUBLIC_AUTH_EMAIL_DOMAIN=example.com         # 기본값 그대로 두면 됩니다
```

이어서 DB(테이블·정책)를 생성합니다:

```bash
# 내 프로젝트와 연결 (2단계에서 정한 DB 비밀번호 입력)
supabase link --project-ref <내-project-ref>

# 테이블/정책 생성 — 'Do you want to push...' 물으면 Y 입력
supabase db push
```

> ✅ 성공하면 Supabase 대시보드의 **Table Editor** 에 `employees`, `customers`, `projects` 등
> 30개 테이블이 생깁니다. (이 스키마는 신규 프로젝트에서 0 에러로 적용되는 것을 검증했습니다.)

---

## 4. 첫 관리자 계정 만들기 ⭐ (로그인하려면 꼭 필요)

> **윤비서에는 회원가입 화면이 없습니다.** 로그인 계정은 아래 명령으로 만드는 **관리자 1개**로 시작하고,
> 직원은 로그인한 뒤 **[직원관리]** 화면에서 추가합니다.

```bash
npm run setup:admin
```

실행하면 **외우기 쉬운 기본 계정**이 만들어집니다:

```
========================================
  🔑 관리자 계정 준비 완료!
  👤 로그인 ID : admin
  🔒 비밀번호  : jadong!
========================================
```

| 로그인 ID | 비밀번호 |
|-----------|----------|
| **admin** | **jadong!** |

> 다른 값으로 만들고 싶으면 `npm run setup:admin -- 원하는ID 원하는비밀번호` (비밀번호는 **6자 이상**).
> 같은 명령을 다시 실행하면 비밀번호가 재설정됩니다.

---

## 5. 실행 & 로그인

```bash
npm run dev
```

서버가 켜질 때 터미널에 **기본 로그인(`admin` / `jadong!`)** 이 배너로 강조 표시됩니다.
브라우저에서 **http://localhost:3000** 접속 → 로그인 화면에서:

- **로그인 ID**: `admin`  ← 이메일이 아니라 **ID** 를 그대로 입력합니다
- **비밀번호**: `jadong!`

🎉 로그인 성공! 이제 윤비서가 내 컴퓨터에서 돌아갑니다.
(서버를 끄려면 터미널에서 `Ctrl + C`, 다시 켜려면 `npm run dev`)

> 🔐 **로그인했으면 비밀번호부터 바꾸세요.** 왼쪽 사이드바 **맨 아래의 '내 이름'을 클릭** →
> **마이페이지**에서 비밀번호를 변경할 수 있습니다. (기본값 `jadong!` 은 누구나 아는 값이라 꼭 변경 권장)

---

## ✅ 설치 완료 체크리스트

- [ ] `git --version` / `node -v`(20.9+) / `gh --version` / `supabase --version` / `vercel --version` 이 모두 나온다
- [ ] `npm install` 이 에러 없이 끝났다
- [ ] (권장) `gh repo create ... --source=. --push` 로 내 GitHub 저장소가 만들어졌다
- [ ] `supabase db push` 가 에러 없이 끝났고, Table Editor 에 테이블이 보인다
- [ ] `npm run setup:admin` 으로 기본 계정(**admin / jadong!**)이 생성됐다
- [ ] `npm run dev` 후 http://localhost:3000 에서 **admin / jadong!** 로 로그인된다
- [ ] 로그인 후 사이드바 하단 '내 이름' → 마이페이지에서 **비밀번호를 변경**했다

---

## 6. (선택) 외부 연동 켜기 — "심화"

**핵심 메뉴(고객·프로젝트·할일·일정·매출·매입·영업이익분석·직원관리 등)는 외부 연동 없이도 잘 돌아갑니다.**
아래는 *있으면 더 좋은* 연동이며, 필요할 때만 켜세요. 대부분 **[시스템설정]** 화면에서 키를 입력합니다.

| 연동 | 켜면 되는 기능 | 필요한 것 | 어디서 설정 |
|------|----------------|-----------|-------------|
| **Google Gemini** | 입금 AI매칭 · 미팅 자동매칭 | Gemini API Key | 시스템설정 화면 |
| **Anthropic Claude** | AI 견적 생성 · 미팅 매칭(보조) | `ANTHROPIC_API_KEY` | ⚠️ **`.env.local` 에만** (시스템설정에 입력란 없음) |
| **Bolta** | 세금계산서 발행(매출 상세) | Bolta API Key | 시스템설정 화면 |
| **Slack** | 프로젝트/할일/매입/입금/일정 알림 | Slack Bot Token | 시스템설정 화면 |
| **Google Drive** | 고객/프로젝트 파일·폴더 | 서비스 계정 + 폴더 공유 | **[docs/GOOGLE_DRIVE_SETUP.md](./docs/GOOGLE_DRIVE_SETUP.md)** |
| **Gmail/Google 캘린더** | 메일·캘린더 연동 | Google OAuth 클라이언트 | `.env.local`(`GOOGLE_OAUTH_*`) |
| **Vercel 배포 + Cron** | 인터넷 배포 · Slack 일정 알림/반복매입 자동생성 | Vercel + `CRON_SECRET` | `vercel` CLI / 대시보드 |

### ⚠️ 학생 환경에서 "데이터가 없어 비어 보이는" 메뉴 (정상입니다)
아래는 **외부 자동 유입**을 전제로 설계돼서, 연동 전에는 화면이 비어 있는 게 정상입니다. 강의에서 참고하세요.

- **반복 매입** — 템플릿 등록은 되지만, 실제 매입 자동생성은 **Vercel Cron**(`generate-recurring-expenses`)이 돌아야 합니다.
- **미팅 자동 전사/요약·입금 자동매칭** — 외부 녹취/은행 웹훅 + AI 키가 있어야 자동화됩니다(수동 입력은 가능).

### 회사 정보(견적서)
상호/대표자/사업자번호/계좌 등은 **기본적으로 비어 있습니다(개인정보 미포함).** 본인 회사 정보로 채우려면:
- 견적서 공급자/계좌: `src/lib/quotation-constants.ts`

---

## 7. (선택) Vercel 로 인터넷에 배포하기

로컬(`npm run dev`)로만 써도 충분하지만, 배포하면 **어디서나(휴대폰 포함) 접속**할 수 있습니다.
Claude Code 에게 **"배포해줘"** 라고 하면 아래 절차를 대신 진행해 줍니다. 직접 하려면:

```bash
# 1) 로그인 (처음 한 번, 브라우저가 열립니다 — 일반 터미널에서 실행)
vercel login

# 2) 프로젝트 생성·연결 (첫 실행 시 자동 생성)
vercel link --yes

# 3) 환경변수 등록 — .env.local 의 4개 값을 그대로 넣습니다 (각 명령 실행 후 값 붙여넣기)
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add NEXT_PUBLIC_AUTH_EMAIL_DOMAIN production

# 4) 배포
vercel --prod
```

끝나면 `https://<프로젝트명>.vercel.app` 주소가 나옵니다. 알아두세요:

- 🔐 **배포하면 그 주소를 아는 누구나 로그인 화면까지는 접근할 수 있습니다.**
  기본 비밀번호(`jadong!`)를 쓰고 있다면 **배포 전에 반드시 변경**하세요(마이페이지).
- **DB 는 그대로 Supabase** 를 쓰므로 로컬과 배포본이 **같은 데이터**를 봅니다.
- 코드를 고친 뒤에는 `vercel --prod` 만 다시 실행하면 재배포됩니다.
- Slack 웹훅/외부 연동을 배포본에서 쓰려면 `NEXT_PUBLIC_APP_URL` 환경변수를 배포 주소로 추가하세요.
- **Cron(자동 배치)**: 기본 포함된 `vercel.json` 의 크론은 **매일 1회 Slack 일정 알림**
  (무료 Hobby 플랜에서 동작)입니다. 분 단위 일정 리마인더·반복매입 자동생성 크론은
  Hobby 플랜 제한(하루 1회)에 걸리므로 Pro 플랜에서 `vercel.json` 의 `crons` 에 추가하세요.
  크론을 쓰려면 `CRON_SECRET` 환경변수도 함께 등록해야 합니다.

---

## 자주 막히는 곳

- **`supabase db push` 에서 권한/연결 오류** → `supabase login` 과
  `supabase link --project-ref ...` 를 다시 확인하세요. 새 프로젝트면 준비(1~2분)를 기다린 뒤 재시도.
- **로그인이 안 됨** → ① 이메일이 아니라 **ID `admin` / 비밀번호 `jadong!`** 로 시도했는지 확인,
  ② `npm run setup:admin` 을 다시 실행해 기본 계정을 재생성(비밀번호 재설정)한 뒤 다시 시도.
- **비밀번호가 너무 짧다는 오류** → 비밀번호는 **6자 이상**이어야 합니다.
- **`npm run build`/실행 실패** → `.env.local` 에 Supabase 값(URL/anon/service_role)이 채워졌는지 확인.

무엇이든 막히면 **Claude Code 에게 에러 메시지를 그대로 붙여넣고 물어보세요.**
