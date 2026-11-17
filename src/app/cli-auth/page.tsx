"use client";

import Image from "next/image";
import { TerminalSquare } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

function isValidPort(value: string | null): value is string {
  if (value === null) return false;
  if (!/^\d+$/.test(value)) return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1024 && n <= 65535;
}

function isValidState(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{16,128}$/.test(value);
}

function isValidRequestId(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

type RequestInfo = {
  hostname: string;
  requested_at: string;
  expires_at: string;
  key_name: string;
  employee_name: string;
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value)
  );
}

function CliAuthInner() {
  const searchParams = useSearchParams();
  const portParam = searchParams.get("port");
  const stateParam = searchParams.get("state");
  // yb 가 먼저 등록한 로그인 요청 id. 이게 없으면(옛 yb, 남이 만든 주소) 승인하지 않는다.
  const requestParam = searchParams.get("request");

  // port 는 선택(1024–65535). port 가 있으면 state(16–128 hex) 필수.
  const validation = useMemo(() => {
    if (!isValidRequestId(requestParam)) {
      return { ok: false as const };
    }
    if (portParam === null) {
      return { ok: true as const, requestId: requestParam, port: null as number | null, state: null as string | null };
    }
    if (!isValidPort(portParam) || !isValidState(stateParam)) {
      return { ok: false as const };
    }
    return { ok: true as const, requestId: requestParam, port: Number(portParam), state: stateParam };
  }, [portParam, stateParam, requestParam]);

  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [userCode, setUserCode] = useState("");

  useEffect(() => {
    if (!validation.ok) return;
    let cancelled = false;
    void fetch(`/api/cli-auth/device?request=${encodeURIComponent(validation.requestId)}`, { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          const returnTo = window.location.pathname + window.location.search;
          window.location.href = `/login?returnTo=${encodeURIComponent(returnTo)}`;
          return;
        }
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) setError(data?.error ?? "요청을 불러오지 못했습니다.");
        else setInfo(data as RequestInfo);
      })
      .catch(() => !cancelled && setError("네트워크 오류로 요청을 불러오지 못했습니다."));
    return () => {
      cancelled = true;
    };
  }, [validation]);

  const handleConfirm = async () => {
    if (!validation.ok) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/cli-auth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: validation.requestId, user_code: userCode }),
      });
      if (res.status === 401) {
        // 로그인 전이면 로그인 화면으로 보냈다가 이 화면으로 돌아온다.
        const returnTo = window.location.pathname + window.location.search;
        window.location.href = `/login?returnTo=${encodeURIComponent(returnTo)}`;
        return;
      }
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.code) {
        setError(data?.error ?? "인증 코드 발급에 실패했습니다.");
        setLoading(false);
        return;
      }

      setCode(data.code);

      // 루프백 서버로 자동 전달 (있을 때만)
      if (validation.port !== null && validation.state) {
        window.location.href =
          `http://127.0.0.1:${validation.port}/callback` +
          `?code=${encodeURIComponent(data.code)}` +
          `&state=${encodeURIComponent(validation.state)}`;
      }
    } catch {
      setError("네트워크 오류로 인증 코드를 발급하지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const manualMode = validation.ok && validation.port === null;

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(13,105,106,0.12),_transparent_32%),radial-gradient(circle_at_bottom,_rgba(180,131,83,0.14),_transparent_28%)]" />

      <Card className="relative z-10 w-full max-w-md border-none py-0 shadow-[0_28px_80px_-42px_rgba(13,77,77,0.32)]">
        <CardContent className="p-8 sm:p-10">
          <div className="space-y-8">
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-xl border border-primary/10 bg-white/85 shadow-[0_24px_40px_-26px_rgba(13,105,106,0.45)]">
                <Image
                  src="/logo.jpg"
                  alt="윤비서 로고"
                  width={80}
                  height={80}
                  className="h-20 w-20 rounded-[1.25rem] object-cover"
                />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                  yb CLI 인증
                </h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  이 컴퓨터의 터미널에서 실행한 yb CLI 를 내 계정에 연결합니다.
                </p>
              </div>
            </div>

            {!validation.ok ? (
              <div className="rounded-2xl border border-destructive/25 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                잘못된 인증 요청입니다. 터미널에서 <code>yb login</code> 을 다시 실행해 주세요.
              </div>
            ) : code ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">인증 코드</p>
                  <div className="rounded-2xl border border-border/70 bg-muted/40 px-4 py-3 font-mono text-sm break-all select-all">
                    {code}
                  </div>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {manualMode
                    ? "위 코드를 복사해 터미널에 붙여넣으세요. (10분 안에 사용)"
                    : "자동 연결이 안 되면 위 코드를 복사해 터미널에 붙여넣으세요. (10분 안에 사용)"}
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                {info ? (
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 rounded-2xl border border-border/70 bg-muted/35 px-4 py-3 text-xs">
                    <dt className="text-muted-foreground">승인하는 직원</dt>
                    <dd className="font-medium">{info.employee_name}</dd>
                    <dt className="text-muted-foreground">요청한 컴퓨터</dt>
                    <dd className="font-medium">{info.hostname}</dd>
                    <dt className="text-muted-foreground">요청 시각</dt>
                    <dd>{formatTime(info.requested_at)}</dd>
                    <dt className="text-muted-foreground">발급될 키</dt>
                    <dd>{info.key_name} (90일 뒤 만료, 마이페이지에서 언제든 지울 수 있음)</dd>
                  </dl>
                ) : null}

                <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-muted/35 px-4 py-3">
                  <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-xs leading-5 text-muted-foreground">
                    <b>내가 직접</b> 터미널에서 <code>yb login</code> 을 실행했을 때만 승인하세요.
                    터미널에 보이는 <b>확인 코드</b>를 아래에 입력합니다. 다른 사람이 알려 준 코드나 주소로는 승인하지 마세요.
                    승인하면 그 컴퓨터의 yb 가 내 이름으로 윤비서 업무를 처리합니다.
                  </p>
                </div>

                <input
                  value={userCode}
                  onChange={(e) => setUserCode(e.target.value.toUpperCase())}
                  placeholder="확인 코드 (예: K7MQ-X9PD)"
                  maxLength={12}
                  autoComplete="off"
                  className="h-11 w-full rounded-md border bg-background px-3 text-center font-mono text-base tracking-widest"
                />

                {error ? (
                  <div className="rounded-2xl border border-destructive/25 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}

                <Button
                  type="button"
                  onClick={handleConfirm}
                  disabled={loading || !info || userCode.replace(/[^A-Z0-9]/g, "").length !== 8}
                  className="h-11 w-full text-sm font-semibold"
                >
                  {loading ? "인증 중..." : "확인 코드로 yb CLI 승인"}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function CliAuthPage() {
  return (
    <Suspense fallback={null}>
      <CliAuthInner />
    </Suspense>
  );
}
