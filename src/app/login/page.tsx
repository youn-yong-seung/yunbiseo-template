"use client";

import Image from "next/image";
import { LockKeyhole, UserRound } from "lucide-react";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendLog } from "@/lib/log-client";
import { createClient } from "@/lib/supabase/client";

function LoginPageInner() {
  const searchParams = useSearchParams();
  const returnToParam = searchParams.get("returnTo");
  // 내부 경로만 허용한다(외부 주소로 튕기는 것 방지).
  const returnTo =
    returnToParam &&
    (returnToParam.startsWith("/dashboard/") || returnToParam.startsWith("/cli-auth"))
      ? returnToParam
      : "/dashboard/workspace";
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setLoading(true);

    const normalizedLoginId = loginId.trim();
    if (!normalizedLoginId || !password) {
      setError("로그인 ID와 비밀번호를 입력해 주세요.");
      setLoading(false);
      return;
    }

    // 비밀번호 확인·실패 횟수 기록은 서버가 한다. 성공하면 서버가 로그인 쿠키를 심는다.
    try {
      const res = await fetch("/api/employees/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login_id: normalizedLoginId, password }),
      });
      const result = await res.json().catch(() => null);
      if (!res.ok || !result?.success) {
        setError(result?.error || "로그인 ID 또는 비밀번호가 올바르지 않습니다.");
        setLoading(false);
        return;
      }
    } catch {
      setError("네트워크 오류로 로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setLoading(false);
      return;
    }

    // 브라우저 Supabase 클라이언트가 서버가 심은 세션을 읽게 한다.
    await createClient().auth.getSession();

    if (rememberMe) {
      localStorage.setItem("rememberMe", "true");
    } else {
      localStorage.removeItem("rememberMe");
    }

    router.push(returnTo);
    sendLog("LOGIN", "Login succeeded");
    router.refresh();
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(13,105,106,0.12),_transparent_32%),radial-gradient(circle_at_bottom,_rgba(180,131,83,0.14),_transparent_28%)]" />

      <Card className="relative z-10 w-full max-w-md border-none py-0 shadow-[0_28px_80px_-42px_rgba(13,77,77,0.32)]">
        <CardContent className="p-8 sm:p-10">
          <div className="space-y-8">
            <div className="space-y-4 text-center">
              <div className="mx-auto flex h-24 w-24 items-center justify-center overflow-hidden rounded-[1.75rem] border border-primary/10 bg-white/85 shadow-[0_24px_40px_-26px_rgba(13,105,106,0.45)]">
                <Image
                  src="/logo.jpg"
                  alt="윤비서 로고"
                  width={80}
                  height={80}
                  className="h-20 w-20 rounded-[1.25rem] object-cover"
                />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">로그인</h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  사내 로그인 ID와 비밀번호를 입력해 업무 공간에 접속하세요.
                </p>
              </div>
            </div>

            <form onSubmit={handleLogin} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="loginId">로그인 ID</Label>
                <div className="relative">
                  <UserRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="loginId"
                    name="loginId"
                    type="text"
                    placeholder="예: yun.manager"
                    value={loginId}
                    onChange={(event) => setLoginId(event.target.value)}
                    autoFocus
                    autoComplete="username"
                    className="h-11 pl-10"
                    disabled={loading}
                    required
                  />
                </div>
                <p className="text-xs text-muted-foreground">이메일이 아니라 사내 로그인 ID만 입력하면 됩니다.</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">비밀번호</Label>
                <div className="relative">
                  <LockKeyhole className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="password"
                    name="password"
                    type="password"
                    placeholder="비밀번호를 입력해 주세요"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                    className="h-11 pl-10"
                    disabled={loading}
                    required
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-muted/35 px-4 py-3">
                <Label htmlFor="rememberMe" className="text-sm font-medium">
                  로그인 상태 유지
                </Label>
                <Checkbox
                  id="rememberMe"
                  checked={rememberMe}
                  onCheckedChange={(checked) => setRememberMe(checked === true)}
                  disabled={loading}
                />
              </div>

              {error ? (
                <div className="rounded-2xl border border-destructive/25 bg-destructive/8 px-4 py-3 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              <Button type="submit" className="h-11 w-full text-sm font-semibold" disabled={loading}>
                {loading ? "로그인 중..." : "로그인"}
              </Button>
            </form>

          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}
