"use client";

import Image from "next/image";
import { TerminalSquare } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
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

function isValidChallenge(value: string | null): value is string {
  return value !== null && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function CliAuthInner() {
  const searchParams = useSearchParams();
  const portParam = searchParams.get("port");
  const stateParam = searchParams.get("state");
  // PKCE: CLI 가 만든 code_challenge. 있으면 서버에 같이 저장해 그 CLI 만 코드를 바꿀 수 있게 한다.
  const challengeParam = searchParams.get("challenge");
  const challenge = isValidChallenge(challengeParam) ? challengeParam : null;

  // port 는 선택(1024–65535). port 가 있으면 state(16–128 hex) 필수.
  const validation = useMemo(() => {
    if (challengeParam !== null && !isValidChallenge(challengeParam)) {
      return { ok: false as const };
    }
    if (portParam === null) {
      return { ok: true as const, port: null as number | null, state: null as string | null };
    }
    if (!isValidPort(portParam) || !isValidState(stateParam)) {
      return { ok: false as const };
    }
    return { ok: true as const, port: Number(portParam), state: stateParam };
  }, [portParam, stateParam, challengeParam]);

  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");

  const handleConfirm = async () => {
    if (!validation.ok) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/cli-auth/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(challenge ? { code_challenge: challenge } : {}),
      });
      if (res.status === 401) {
        // 로그인 전이면 로그인 화면으로 보냈다가 이 화면(포트·state 그대로)으로 돌아온다.
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
                <div className="flex items-start gap-3 rounded-2xl border border-border/70 bg-muted/35 px-4 py-3">
                  <TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <p className="text-xs leading-5 text-muted-foreground">
                    본인이 터미널에서 <code>yb login</code> 을 실행한 것이 맞을 때만 인증하세요.
                    발급된 키로 CLI 가 내 계정 권한으로 윤비서 업무를 처리합니다.
                  </p>
                </div>

                {error ? (
                  <div className="rounded-2xl border border-destructive/25 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                    {error}
                  </div>
                ) : null}

                <Button
                  type="button"
                  onClick={handleConfirm}
                  disabled={loading}
                  className="h-11 w-full text-sm font-semibold"
                >
                  {loading ? "인증 중..." : "이 컴퓨터에서 yb CLI 인증"}
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
