"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard, NotebookPen, Wallet } from "lucide-react";
import { toast } from "sonner";

import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  PageShell,
  PageToolbar,
  StatCard,
  StatsGrid,
} from "@/components/page-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createClient } from "@/lib/supabase/client";

type CorporateCard = {
  id: string;
  alias: string | null;
  last4: string;
  issuer: string | null;
  holder_employee_id: string | null;
  is_active: boolean;
  employees?: { id: string; name: string } | null;
};

type CardTransaction = {
  id: string;
  card_last4: string | null;
  amount: number;
  currency: string;
  foreign_amount: number | null;
  merchant: string | null;
  approved_at: string;
  description: string | null;
  status: "pending" | "confirmed" | "ignored";
  is_cancellation: boolean;
  source: "webhook" | "manual";
  parse_status: string;
  corporate_cards?: { alias: string | null; last4: string } | null;
};

type Employee = { id: string; name: string };

const STATUS_LABEL: Record<CardTransaction["status"], string> = {
  pending: "적요 대기",
  confirmed: "확인",
  ignored: "무시",
};

const fmt = (n: number) => n.toLocaleString("ko-KR");

function currentMonth() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(`${month}-01T00:00:00+09:00`);
  const next = new Date(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}-01T00:00:00+09:00`);
  return { start: start.toISOString(), end: next.toISOString() };
}

function formatKst(iso: string) {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CardTransactionsPage() {
  const supabase = useMemo(() => createClient(), []);
  const [month, setMonth] = useState(currentMonth);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [rows, setRows] = useState<CardTransaction[]>([]);
  const [cards, setCards] = useState<CorporateCard[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [cardDialogOpen, setCardDialogOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(false);
    await supabase.auth.getSession();
    const { start, end } = monthRange(month);
    const [txResult, cardResult, employeeResult] = await Promise.all([
      supabase
        .from("card_transactions")
        .select("*, corporate_cards(alias, last4)")
        .gte("approved_at", start)
        .lt("approved_at", end)
        .order("approved_at", { ascending: false })
        .limit(1000),
      supabase.from("corporate_cards").select("*, employees(id, name)").order("created_at"),
      supabase.from("employees").select("id, name").order("name"),
    ]);
    if (txResult.error || cardResult.error) {
      console.error("법인카드 조회 실패:", txResult.error?.message ?? cardResult.error?.message);
      setError(true);
    } else {
      setRows((txResult.data ?? []) as CardTransaction[]);
      setCards((cardResult.data ?? []) as CorporateCard[]);
      setEmployees((employeeResult.data ?? []) as Employee[]);
      setDrafts({});
    }
    setLoading(false);
  }, [supabase, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchData();
  }, [fetchData]);

  const isMissing = (row: CardTransaction) => !row.description && row.status !== "ignored" && !row.is_cancellation;
  const visible = onlyMissing ? rows.filter(isMissing) : rows;
  const totalSpent = rows.filter((r) => r.status !== "ignored").reduce((sum, r) => sum + r.amount, 0);
  const missingCount = rows.filter(isMissing).length;

  const updateRow = async (row: CardTransaction, patch: Partial<CardTransaction>) => {
    const { error: updateError } = await supabase.from("card_transactions").update(patch).eq("id", row.id);
    if (updateError) {
      toast.error("저장하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
  };

  const saveDescription = async (row: CardTransaction) => {
    const draft = drafts[row.id];
    if (draft === undefined) return;
    const description = draft.trim() || null;
    if (description === (row.description ?? null)) return;
    // 적요를 적으면 '확인'으로, 지우면 다시 '적요 대기'로 둔다(무시한 건은 그대로).
    const status = row.status === "ignored" ? "ignored" : description ? "confirmed" : "pending";
    await updateRow(row, { description, status });
    toast.success("적요를 저장했습니다.");
  };

  const cardLabel = (row: CardTransaction) => {
    const card = row.corporate_cards;
    if (card) return card.alias ? `${card.alias} (${card.last4})` : card.last4;
    return row.card_last4 ? `${row.card_last4} (미등록)` : "-";
  };

  const amountLabel = (row: CardTransaction) =>
    row.currency !== "KRW" && row.foreign_amount !== null
      ? `${row.currency} ${row.foreign_amount}${row.amount ? ` (${fmt(row.amount)}원)` : ""}`
      : `${fmt(row.amount)}원`;

  return (
    <PageShell>
      <PageHeader
        title="법인카드"
        description="카드 승인 문자가 들어오면 한 줄씩 쌓입니다. 어디에 썼는지(적요)를 적어 두세요."
        actions={
          <Button variant="outline" size="sm" onClick={() => setCardDialogOpen(true)}>
            카드 관리
          </Button>
        }
      />

      <StatsGrid>
        <StatCard label="이번 달 사용액" value={`${fmt(totalSpent)}원`} icon={Wallet} sensitive="amount" />
        <StatCard
          label="적요 미작성"
          value={`${missingCount}건`}
          icon={NotebookPen}
          tone={missingCount > 0 ? "warning" : "success"}
        />
        <StatCard label="등록 카드" value={`${cards.filter((c) => c.is_active).length}장`} icon={CreditCard} />
      </StatsGrid>

      <PageToolbar>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value || currentMonth())} className="w-full sm:w-44" />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyMissing} onCheckedChange={(v) => setOnlyMissing(v === true)} />
            적요 안 적은 것만
          </label>
        </div>
      </PageToolbar>

      {loading ? (
        <LoadingState title="카드 사용내역을 불러오는 중입니다." />
      ) : error ? (
        <ErrorState
          description="카드 사용내역을 불러오지 못했습니다. 법인카드 마이그레이션(supabase db push)을 했는지 확인해 주세요."
          action={
            <Button variant="outline" size="sm" onClick={() => void fetchData()}>
              다시 시도
            </Button>
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "이 달 카드 사용내역이 없습니다." : "적요를 모두 적었습니다."}
          description={
            rows.length === 0
              ? "폰의 카드 승인 문자를 윤비서로 보내도록 설정하면 결제할 때마다 자동으로 쌓입니다. 방법은 SETUP.md '법인카드 문자 연동'에 있습니다."
              : "이 달에 적요가 빈 내역이 없습니다."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-[1.5rem] border border-border/70 bg-card/90 shadow-sm">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">승인일시</TableHead>
                  <TableHead>카드</TableHead>
                  <TableHead>가맹점</TableHead>
                  <TableHead className="text-right">금액</TableHead>
                  <TableHead className="min-w-[240px]">적요</TableHead>
                  <TableHead>상태</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => (
                  <TableRow key={row.id} className={row.status === "ignored" ? "opacity-60" : undefined}>
                    <TableCell className="whitespace-nowrap">{formatKst(row.approved_at)}</TableCell>
                    <TableCell className="whitespace-nowrap">{cardLabel(row)}</TableCell>
                    <TableCell className="max-w-[180px] truncate">
                      {row.merchant ?? <span className="text-muted-foreground">가맹점 미확인</span>}
                      {row.is_cancellation ? <Badge variant="outline" className="ml-2">취소</Badge> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">{amountLabel(row)}</TableCell>
                    <TableCell>
                      <Input
                        value={drafts[row.id] ?? row.description ?? ""}
                        placeholder="예: 고객 미팅 커피 3잔"
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                        onBlur={() => void saveDescription(row)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </TableCell>
                    <TableCell>
                      <select
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                        value={row.status}
                        onChange={(e) => void updateRow(row, { status: e.target.value as CardTransaction["status"] })}
                      >
                        {Object.entries(STATUS_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <CardManageDialog
        open={cardDialogOpen}
        onOpenChange={setCardDialogOpen}
        cards={cards}
        employees={employees}
        onChanged={() => void fetchData()}
      />
    </PageShell>
  );
}

function CardManageDialog({
  open,
  onOpenChange,
  cards,
  employees,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cards: CorporateCard[];
  employees: Employee[];
  onChanged: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [last4, setLast4] = useState("");
  const [alias, setAlias] = useState("");
  const [issuer, setIssuer] = useState("");
  const [holder, setHolder] = useState("");
  const [saving, setSaving] = useState(false);

  const addCard = async () => {
    if (!/^\d{4}$/.test(last4)) {
      toast.error("카드 끝 4자리 숫자를 넣어 주세요.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("corporate_cards").insert({
      last4,
      alias: alias.trim() || null,
      issuer: issuer.trim() || null,
      holder_employee_id: holder || null,
    });
    if (!error) {
      // 등록 전에 들어온 같은 끝자리 내역도 이 카드에 잇는다.
      const { data: card } = await supabase.from("corporate_cards").select("id").eq("last4", last4).eq("is_active", true).maybeSingle();
      if (card) await supabase.from("card_transactions").update({ card_id: card.id }).eq("card_last4", last4).is("card_id", null);
    }
    setSaving(false);
    if (error) {
      toast.error(error.code === "23505" ? "같은 끝 4자리 카드가 이미 있습니다." : "카드를 등록하지 못했습니다.");
      return;
    }
    toast.success("카드를 등록했습니다.");
    setLast4("");
    setAlias("");
    setIssuer("");
    setHolder("");
    onChanged();
  };

  const toggleActive = async (card: CorporateCard) => {
    const { error } = await supabase.from("corporate_cards").update({ is_active: !card.is_active }).eq("id", card.id);
    if (error) {
      toast.error(error.code === "23505" ? "같은 끝 4자리의 쓰는 카드가 이미 있습니다." : "바꾸지 못했습니다.");
      return;
    }
    onChanged();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>카드 관리</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          승인 문자에 찍히는 카드 끝 4자리를 등록하면, 문자가 어느 카드인지 알아서 이어 줍니다. 카드번호 전체는 넣지 않습니다.
        </p>
        <div className="space-y-2">
          {cards.length === 0 ? (
            <p className="text-sm text-muted-foreground">등록된 카드가 없습니다.</p>
          ) : (
            cards.map((card) => (
              <div key={card.id} className="flex items-center justify-between rounded-lg border p-2 text-sm">
                <span>
                  {card.alias ?? "카드"} ({card.last4}){card.issuer ? `, ${card.issuer}` : ""}
                  {card.employees ? `, ${card.employees.name}` : ""}
                  {!card.is_active ? <Badge variant="outline" className="ml-2">안 씀</Badge> : null}
                </span>
                <Button variant="ghost" size="sm" onClick={() => void toggleActive(card)}>
                  {card.is_active ? "안 씀으로" : "다시 쓰기"}
                </Button>
              </div>
            ))
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 border-t pt-4">
          <div className="space-y-1">
            <Label htmlFor="card-last4">끝 4자리</Label>
            <Input id="card-last4" inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="card-alias">별칭</Label>
            <Input id="card-alias" placeholder="예: 대표 카드" value={alias} onChange={(e) => setAlias(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="card-issuer">카드사</Label>
            <Input id="card-issuer" placeholder="예: 신한" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="card-holder">쓰는 사람</Label>
            <select
              id="card-holder"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={holder}
              onChange={(e) => setHolder(e.target.value)}
            >
              <option value="">선택 안 함</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Button onClick={() => void addCard()} disabled={saving}>
          {saving ? "등록 중..." : "카드 등록"}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
