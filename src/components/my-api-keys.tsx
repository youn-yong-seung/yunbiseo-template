"use client";

import { Check, Copy, KeyRound, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SectionCard, SectionIntro } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type MyApiKey = {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
};

function formatDateTime(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

/**
 * 마이페이지 "내 API 키": AI 앱(yb CLI)·폰 문자 연동에 쓰는 내 키를 만들고 지운다.
 * 키는 만든 사람(나) 명의로 동작한다. 원문은 만든 직후 한 번만 보여 준다.
 */
export function MyApiKeys() {
  const [keys, setKeys] = useState<MyApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/api-keys?scope=mine", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      setKeys(res.ok ? (json?.data ?? []) : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const keyName = name.trim() || "AI 앱";
    setCreating(true);
    try {
      const res = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: keyName, expires_in_days: Number(days) }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.data?.raw_key) {
        toast.error(json?.error ?? "API 키를 만들지 못했습니다.");
        return;
      }
      setNewKey(json.data.raw_key as string);
      setCopied(false);
      setName("");
      await load();
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (key: MyApiKey) => {
    if (!window.confirm(`'${key.name}' 키를 지울까요? 이 키를 쓰던 AI 앱·폰 연동은 바로 멈춥니다.`)) return;
    const res = await fetch(`/api/api-keys/${key.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("API 키를 지우지 못했습니다.");
      return;
    }
    toast.success("API 키를 지웠습니다.");
    await load();
  };

  const handleCopy = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
    } catch {
      toast.error("복사하지 못했습니다. 직접 선택해 복사해 주세요.");
    }
  };

  return (
    <section className="space-y-4">
      <SectionIntro
        title="내 API 키"
        description="Claude Code·Codex 같은 AI 앱이 윤비서를 내 이름으로 다룰 때 쓰는 열쇠입니다. 남에게 보여 주지 마세요."
      />
      <SectionCard className="gap-4">
        <form onSubmit={handleCreate} className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="키 이름 (예: 내 노트북 Claude Code)"
            maxLength={100}
          />
          <select
            aria-label="사용 기간"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            className="h-9 shrink-0 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="30">30일</option>
            <option value="90">90일</option>
            <option value="180">180일</option>
            <option value="365">1년</option>
          </select>
          <Button type="submit" disabled={creating} className="shrink-0">
            <KeyRound className="mr-1 h-4 w-4" />
            {creating ? "만드는 중..." : "새 API 키 만들기"}
          </Button>
        </form>

        {newKey ? (
          <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="text-sm font-medium">새 키 — 지금 한 번만 보입니다. 복사해 AI 앱에 붙여 넣으세요.</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded bg-background px-2 py-1 text-xs">{newKey}</code>
              <Button type="button" size="sm" variant="outline" onClick={() => void handleCopy()}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setNewKey(null)}>
              다 복사했어요
            </Button>
          </div>
        ) : null}

        {loading ? (
          <p className="text-sm text-muted-foreground">불러오는 중...</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">아직 만든 키가 없습니다.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{key.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {key.key_prefix} · 만든 날 {formatDateTime(key.created_at)} · 마지막 사용 {formatDateTime(key.last_used_at)}
                    {key.expires_at ? ` · 만료 ${formatDateTime(key.expires_at)}` : ""}
                  </p>
                </div>
                <Button type="button" size="sm" variant="ghost" onClick={() => void handleDelete(key)} aria-label="API 키 지우기">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </section>
  );
}
