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
> - 원본 템플릿이 업데이트되면 `git pull template main` 으로 받아올 수 있습니다(8장 "템플릿 업데이트 받기").
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

실행하면 로그인 ID `admin` 과 **이번 설치에서만 쓰는 무작위 비밀번호**가 만들어집니다:

```
========================================
  🔑 관리자 계정 준비 완료!
  👤 로그인 ID : admin
  🔒 비밀번호  : jadong-k7m2-x9qp   ← 예시. 실제 값은 실행할 때마다 다릅니다
========================================
```

> 🔐 **이 비밀번호는 한 번만 보여 줍니다. 바로 메모해 두세요.**
> 예전처럼 모두가 아는 고정 비밀번호(공개 저장소에 적힌 값)를 쓰면, 배포한 주소를 아는 누구나 관리자로 들어올 수 있어서 바꿨습니다.
>
> - 잊어버렸으면 `npm run setup:admin` 을 다시 실행하세요. 새 비밀번호로 바뀝니다.
> - 직접 정하고 싶으면 `npm run setup:admin -- 원하는ID 원하는비밀번호` (비밀번호는 **10자 이상**).

---

## 5. 실행 & 로그인

```bash
npm run dev
```

서버가 켜질 때 터미널에 로그인 안내 배너가 나옵니다.
브라우저에서 **http://localhost:3000** 접속 → 로그인 화면에서:

- **로그인 ID**: `admin`  ← 이메일이 아니라 **ID** 를 그대로 입력합니다
- **비밀번호**: 4단계에서 `setup:admin` 이 보여 준 비밀번호

🎉 로그인 성공! 이제 윤비서가 내 컴퓨터에서 돌아갑니다.
(서버를 끄려면 터미널에서 `Ctrl + C`, 다시 켜려면 `npm run dev`)

> 🔐 **로그인했으면 비밀번호부터 바꾸세요.** 왼쪽 사이드바 **맨 아래의 '내 이름'을 클릭** →
> **마이페이지**에서 비밀번호를 변경할 수 있습니다. (8자 이상)

---

## ✅ 설치 완료 체크리스트

- [ ] `git --version` / `node -v`(20.9+) / `gh --version` / `supabase --version` / `vercel --version` 이 모두 나온다
- [ ] `npm install` 이 에러 없이 끝났다
- [ ] (권장) `gh repo create ... --source=. --push` 로 내 GitHub 저장소가 만들어졌다
- [ ] `supabase db push` 가 에러 없이 끝났고, Table Editor 에 테이블이 보인다
- [ ] `npm run setup:admin` 으로 관리자 계정(**admin / 화면에 나온 비밀번호**)이 생성됐고, 비밀번호를 메모했다
- [ ] `npm run dev` 후 http://localhost:3000 에서 그 ID·비밀번호로 로그인된다
- [ ] 로그인 후 사이드바 하단 '내 이름' → 마이페이지에서 **비밀번호를 변경**했다

---

## 6. (선택) 외부 연동 켜기 — "심화"

**핵심 메뉴(고객·프로젝트·할일·일정·매출·매입·영업이익분석·직원관리 등)는 외부 연동 없이도 잘 돌아갑니다.**
아래는 *있으면 더 좋은* 연동이며, 필요할 때만 켜세요. 대부분 **[시스템설정]** 화면에서 키를 입력합니다.

| 연동 | 켜면 되는 기능 | 필요한 것 | 어디서 설정 |
|------|----------------|-----------|-------------|
| **Google Gemini** | 입금 AI매칭 · 미팅 자동매칭 | Gemini API Key | 시스템설정 화면 |
| **Anthropic Claude** | AI 견적 생성 · 미팅 매칭(보조) | `ANTHROPIC_API_KEY` | ⚠️ **`.env.local` 에만** (시스템설정에 입력란 없음) |
| **Bolta** | 세금계산서 자동 발행(매출 상세, `yb revenue tax-invoice issue`) | Bolta API Key + Customer Key | 시스템설정 화면 또는 `.env.local`(`BOLTA_*`) |
| **Slack** | 프로젝트/할일/매입/입금/일정 알림 | Slack Bot Token | 시스템설정 화면 |
| **Google Drive** | 고객/프로젝트 파일·폴더 | 서비스 계정 + 폴더 공유 | **[docs/GOOGLE_DRIVE_SETUP.md](./docs/GOOGLE_DRIVE_SETUP.md)** |
| **Gmail/Google 캘린더** | 메일·캘린더 연동 | Google OAuth 클라이언트 | `.env.local`(`GOOGLE_OAUTH_*`) |
| **Vercel 배포 + Cron** | 인터넷 배포 · Slack 일정 알림/반복매입 자동생성 | Vercel + `CRON_SECRET` | `vercel` CLI / 대시보드 |

**볼타를 연결하지 않아도 매출 관리는 그대로 됩니다.** 세금계산서는 홈택스에서 직접 발행한 뒤, 매출 수정 화면에서 '세금계산서 발행완료'를 체크하거나
`yb revenue update <매출id> --tax-invoice true --tax-invoice-date 2026-11-17` 로 표시하면 됩니다. 볼타 없이 자동 발행 버튼을 누르면
"볼타 API 키가 없어 자동 발행을 쓸 수 없습니다" 라고 안내만 하고 아무것도 바뀌지 않습니다.

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
  비밀번호를 남과 공유했다면 **배포 전에 변경**하세요(마이페이지). 5번 틀리면 15분 동안 로그인이 잠깁니다.
- 🔐 **(권장) Supabase 회원가입을 끄세요.** Supabase 대시보드 → Authentication → Sign In / Providers →
  "Allow new users to sign up" 을 끕니다. 윤비서는 회원가입 화면을 쓰지 않습니다(직원은 관리자가 [직원관리]에서 만듭니다).
  켜 둬도 직원으로 등록되지 않은 계정은 서버와 DB 정책이 막지만, 끄면 한 겹 더 안전합니다.
- **DB 는 그대로 Supabase** 를 쓰므로 로컬과 배포본이 **같은 데이터**를 봅니다.
- 코드를 고친 뒤에는 `vercel --prod` 만 다시 실행하면 재배포됩니다.
- Slack 웹훅/외부 연동을 배포본에서 쓰려면 `NEXT_PUBLIC_APP_URL` 환경변수를 배포 주소로 추가하세요.
- **Cron(자동 배치)**: 기본 포함된 `vercel.json` 의 크론은 **매일 1회 Slack 일정 알림**
  (무료 Hobby 플랜에서 동작)입니다. 분 단위 일정 리마인더·반복매입 자동생성 크론은
  Hobby 플랜 제한(하루 1회)에 걸리므로 Pro 플랜에서 `vercel.json` 의 `crons` 에 추가하세요.
  크론을 쓰려면 `CRON_SECRET` 환경변수도 함께 등록해야 합니다.

---

## 8. (선택) yb CLI 로 AI 에게 윤비서 일 맡기기

`yb` 는 윤비서를 터미널 명령으로 다루는 도구입니다. Claude Code·Codex 같은 AI 앱이 이걸로
윤비서의 일정·할 일·고객·프로젝트·매출·세금계산서·매입·입금·법인카드를 대신 조회하고 등록합니다.
이 저장소의 `tools/yb.mjs` 에 들어 있습니다.

> **가장 쉬운 방법:** AI 앱에 **"윤비서 CLI 설치해줘"** 라고 말하세요. 화면별 안내와 말 예시는
> **[docs/YB_CLI_START.md](./docs/YB_CLI_START.md)** (강사·수강생 공용 안내서)에 있습니다.

직접 하려면:

```bash
# 1) yb 명령 등록 (저장소 폴더에서 처음 한 번)
npm link

# 2-가) API 키로 연결 — 윤비서 로그인 → 왼쪽 아래 '내 이름' → 마이페이지 → '내 API 키' → [새 API 키 만들기]
yb auth --key ys_... --url http://localhost:3000   # 배포했다면 https://<프로젝트명>.vercel.app

# 2-나) 또는 브라우저로 연결 (처음 한 번, 브라우저가 열립니다)
yb login --url http://localhost:3000

# 3) 확인 — 내 이름이 나오면 성공
yb whoami
yb today
```

- `yb auth --key` 는 저장하기 전에 서버에 "이 키 주인이 누구인지" 물어봐서, 틀린 키·주소는 저장하지 않습니다.
- 브라우저 연결은 윤비서 로그인 → **"이 컴퓨터에서 yb CLI 인증"** 을 누르면 키가 자동으로 발급·저장됩니다
  (`~/.config/yunbiseo-template/config.json`, 나만 읽을 수 있는 권한). 마이페이지 키 목록에 `yb-cli <컴퓨터 이름>` 으로 보입니다.
- 브라우저가 자동으로 안 돌아오면 `yb login --url <주소> --manual` 로 코드를 복사해 붙여넣습니다.
- `npm link` 가 권한 오류로 막히면 `npm run yb -- help` 처럼 저장소 폴더에서 실행해도 됩니다.
- 자주 쓰는 말: `yb today`(오늘 할 일·일정), `yb schedule create --title "고객 미팅" --date "다음주 화" --time 14:00`,
  `yb give 나 "견적서 보내기" --due 내일`(할 일 맡기기, 번호가 2001부터) → `yb done 2001 --note "보냄"`,
  `yb project status 26-1 진행중 -m "계약 완료"`, `yb customer create --name 고객이름`.
- API 키는 만든 직원 이름으로 동작합니다. 일정·할 일은 모두 볼 수 있지만 고치고 지우는 것은 만든 사람·담당자·관리자만 됩니다.
- AI 에게 `yb login` 을 반복해서 시키지 마세요(브라우저 창이 계속 뜹니다). 이름 확인은 `yb whoami` 입니다.
- `tools/yb.mjs` 는 자동 생성 파일이라 직접 고치지 않습니다.

### 템플릿 업데이트 받기 (새 기능이 나왔을 때)

```bash
git pull template main      # 원본 템플릿의 새 코드 받기 (1장에서 'template' 이름으로 남겨 둔 리모트)
npm install                 # 새 패키지가 있으면 설치
supabase db push            # 새 테이블 만들기 — 'Do you want to push...' 물으면 Y
```

`supabase db push` 를 빼먹으면 새 메뉴(예: 법인카드)가 "불러오지 못했습니다" 로 뜹니다. 배포했다면 `vercel --prod` 로 다시 배포합니다.

> **2026-11 보안 업데이트를 받은 뒤에는**: 회사 데이터는 "직원으로 등록된 활성 계정"만 볼 수 있고, API 키는 만든 직원 이름으로 동작합니다.
> 업데이트 전에 만든 키 중 주인을 알 수 없는 키(만든 사람 이름이 직원 이름과 다르거나 같은 이름이 둘 이상)는 막힙니다.
> `yb whoami` 가 실패하면 마이페이지 → 내 API 키에서 새로 만들어 `yb auth --key` 로 다시 넣으세요.

---

## 9. (선택) 법인카드 문자 연동 — 결제하면 윤비서에 자동으로 한 줄

> **Claude Code 에게 "카드 문자 연동 도와줘" 라고 하면** 서버 확인·시험을 대신하고 폰 설정을 한 단계씩 안내합니다.
> 화면별 상세 설명과 안 될 때 해결법은 **[docs/CARD_SMS_SETUP.md](./docs/CARD_SMS_SETUP.md)** 에 있습니다.

카드로 결제하면 카드사 승인 문자가 옵니다. 폰이 이 문자를 윤비서로 보내게 하면, 윤비서가 금액·가맹점·승인시각·카드 끝 4자리를 읽어
**법인카드** 메뉴에 한 줄을 만듭니다. 나중에 적요(어디에 썼는지)만 적으면 됩니다(`yb card update <id> --description "고객 미팅 커피"`).

**먼저 준비할 것**
1. 윤비서를 인터넷에 배포합니다(7장). 폰은 내 컴퓨터의 `localhost` 에 닿지 않습니다.
2. 윤비서 → **법인카드 → 카드 관리** 에서 카드 끝 4자리를 등록합니다(카드번호 전체는 넣지 않습니다).
3. 시스템 설정 → API 키에서 **문자 연동 전용 키**를 하나 만듭니다. 폰을 잃어버리면 이 키만 지우면 됩니다.

보낼 곳은 하나입니다.

| 항목 | 값 |
|---|---|
| 주소 | `https://내-윤비서-주소/api/card-transactions/webhook` |
| 방법 | `POST` |
| 헤더 | `x-api-key` = 문자 연동 전용 키 |
| 본문 | 문자 원문 그대로(텍스트), 또는 JSON `{"text": "문자 원문"}` |

### 아이폰: 단축어 자동화 (iOS 17 이상)
1. **단축어** 앱 → 아래 **자동화** 탭 → `+` → **메시지**.
2. **메시지에 포함**: `승인` (또는 **보낸 사람**에 카드사 문자 번호).
3. **즉시 실행**을 고릅니다(실행 전 확인 끄기).
4. 동작 추가 → **URL의 콘텐츠 가져오기**
   - URL: 위 주소, 방법: **POST**
   - 헤더: `x-api-key` / 문자 연동 전용 키
   - 본문 요청: **JSON**, 키 `text`, 값은 변수 **단축어 입력**(메시지 내용).
5. 소액 결제로 시험해 법인카드 메뉴에 한 줄이 생기는지 봅니다.

### 안드로이드: MacroDroid (무료, 매크로 5개까지)
1. Play 스토어에서 **MacroDroid** 설치 → **매크로 추가**.
2. **트리거: 알림 수신** → 앱: 메시지(문자 앱) → 텍스트 포함 `승인`. 알림 접근 권한을 허용합니다.
   카드사 문자는 'SMS 수신' 트리거로 안 잡히는 경우가 있어 **알림** 트리거를 씁니다.
3. **동작: HTTP 요청**
   - 방법 **POST**, URL 위 주소
   - 헤더 `x-api-key` = 문자 연동 전용 키
   - 본문 형식 `text/plain`, 내용은 매직 텍스트의 **알림 텍스트**.
4. 휴대폰 설정 → 배터리 → MacroDroid 를 **제한 없음**으로 둡니다(꺼지면 문자가 빠집니다).
5. 소액 결제로 시험합니다.

**알아 두면 좋은 것**
- 인증번호 문자처럼 카드 결제가 아닌 문자는 저장하지 않습니다. 같은 문자가 두 번 와도 한 줄만 남습니다.
- 승인 취소 문자가 오면 원래 승인 건과 취소 건을 둘 다 '무시'로 바꿉니다.
- 문자로 안 들어온 건은 `yb card create --amount 12000 --merchant 가맹점 --approved-at 2026-11-17` 로 넣습니다.
- 문자 해석은 국내 주요 카드사 형식을 읽도록 만들었지만, 카드사마다 문자 모양이 달라 가맹점이 비어 들어올 수 있습니다.
  그럴 땐 화면이나 `yb card update <id> --merchant 가맹점` 으로 고칩니다.

---

## 자주 막히는 곳

- **`supabase db push` 에서 권한/연결 오류** → `supabase login` 과
  `supabase link --project-ref ...` 를 다시 확인하세요. 새 프로젝트면 준비(1~2분)를 기다린 뒤 재시도.
- **로그인이 안 됨** → ① 이메일이 아니라 **ID `admin`** 과 `setup:admin` 이 보여 준 비밀번호로 시도했는지 확인,
  ② `npm run setup:admin` 을 다시 실행해 새 비밀번호를 받은 뒤 다시 시도.
  ③ "5번 틀려 15분 동안 로그인할 수 없습니다" 가 나오면 15분 뒤 다시 하거나 ②로 비밀번호를 새로 받습니다.
- **비밀번호가 너무 짧다는 오류** → `setup:admin` 에 직접 줄 때는 **10자 이상**, 마이페이지에서 바꿀 때는 **8자 이상**이어야 합니다.
- **`npm run build`/실행 실패** → `.env.local` 에 Supabase 값(URL/anon/service_role)이 채워졌는지 확인.

무엇이든 막히면 **Claude Code 에게 에러 메시지를 그대로 붙여넣고 물어보세요.**
