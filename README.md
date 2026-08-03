# 윤비서 템플릿 (Yun Secretary Template)

자연어로 사내 업무를 다루는 **AI 비서형 업무관리 시스템**의 학습용 템플릿입니다.
클래스101 「클로드코드 4주 과정」 수강생이 클론해서 로컬에서 실행하고,
각자 본인 시스템으로 발전시키도록 만들어졌습니다.

> **시작하기 (처음이라면):** 아래 한 줄로 코드를 내려받은 뒤, 그 폴더를
> **Claude Code 로 열고 "초기 설정 도와줘"** 라고 말하면 처음부터 끝까지 같이 설치해 줍니다.
> (또는 `/setup` 입력) · 직접 하려면 → **[SETUP.md](./SETUP.md)**.
>
> ```bash
> git clone https://github.com/youn-yong-seung/yunbiseo-template.git my-secretary
> cd my-secretary
> ```

## 기술 스택

- **Next.js 16** (App Router) + **React 19** + **TypeScript**
- **Supabase** (Postgres + Auth + RLS)
- **Tailwind CSS v4** + shadcn/ui + Pretendard

## 포함된 기능 (메뉴)

워크스페이스 · 고객관리 · 프로젝트관리 · 할일관리 · 일정관리 · 미팅관리 ·
견적관리 · 매출관리 · 입금관리 · 매입관리 · 영업이익분석 ·
직원관리 · 시스템설정 · 마이페이지

## 빠른 시작

모든 과정이 **CLI-first** 입니다 — GitHub·Supabase·Vercel 을 전부 명령줄로 다루고, Claude Code 가 대신 실행해 줍니다.

```bash
npm install
gh auth login                   # (권장) GitHub 로그인 → 내 비공개 저장소 만들기
git remote rename origin template && gh repo create my-secretary --private --source=. --push
supabase login                  # 브라우저 인증 (대시보드 키 복사 불필요)
supabase projects create "yun-secretary" --org-id <org> --db-password <pw> --region ap-northeast-2
cp .env.example .env.local
supabase projects api-keys --project-ref <ref>   # anon/service_role 키를 .env.local 에 기입
supabase link --project-ref <ref> && supabase db push   # 테이블 생성
npm run setup:admin             # 기본 관리자 계정 생성 → admin / jadong!
npm run dev                     # http://localhost:3000  (admin / jadong! 로 로그인)
```

> 로그인 후 **사이드바 하단 '내 이름' → 마이페이지**에서 비밀번호를 꼭 바꾸세요.

인터넷 배포까지 원하면 Claude Code 에게 **"배포해줘"** (또는 `/deploy`) — `vercel login` 한 번이면
프로젝트 생성·환경변수 등록·배포를 알아서 진행합니다.

자세한 내용은 **[SETUP.md](./SETUP.md)** 참고.

## 선택(심화) 연동

키가 없어도 앱은 동작합니다. 필요할 때 **[시스템설정]** 화면 또는 `.env.local` 에서 켜세요.

| 기능 | 필요한 키 |
|------|-----------|
| 입금 AI매칭 / AI견적 | Google Gemini |
| 세금계산서 발행 | Bolta |
| Slack 알림 | Slack Bot |
| 메일/캘린더/드라이브 | Google (기본 비활성) |

## 참고

학습용 템플릿입니다. 회사 정보(상호·대표자·사업자번호·계좌 등)는 비어 있으니
본인 정보로 채워 사용하세요. 자세한 규약은 [CLAUDE.md](./CLAUDE.md) 참고.
