import { NextResponse } from "next/server";
import { publicErrorMessage } from "@/lib/safe-error";
import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import {
  normalizeBusinessName,
  suggestDepositRevenueMatch,
  type RevenueCandidate,
} from "@/lib/gemini-deposit-match";
import { logInfo } from "@/lib/logger";

type DepositRow = {
  id: string;
  deposit_date: string;
  amount: number;
  depositor_name: string;
  memo: string | null;
};

type RevenueRow = {
  id: string;
  title: string;
  total_amount: number;
  supply_amount: number;
  expected_payment_date: string | null;
  projects: {
    name: string | null;
    client: string | null;
    customers: {
      name: string | null;
      account_holder: string | null;
    } | null;
  } | null;
};

interface ExactMatchResult {
  deposit_id: string;
  depositor_name: string;
  amount: number;
  deposit_date: string;
  revenue_id: string;
  revenue_title: string;
  revenue_amount: number;
  project_name: string | null;
  match_type: "exact_name_amount";
}

interface AiMatchResult {
  deposit_id: string;
  depositor_name: string;
  amount: number;
  deposit_date: string;
  suggestions: Array<{
    revenue_id: string;
    revenue_title: string;
    revenue_amount: number;
    project_name: string | null;
    confidence: "high" | "medium" | "low";
    reason: string;
  }>;
}

interface UnmatchedDeposit {
  deposit_id: string;
  depositor_name: string;
  amount: number;
  deposit_date: string;
}

function buildRevenueNameKeys(revenue: RevenueRow): string[] {
  const names = [
    revenue.projects?.customers?.name,
    revenue.projects?.customers?.account_holder,
    revenue.projects?.client,
    revenue.projects?.name,
    revenue.title,
  ];

  const keys = new Set<string>();
  for (const name of names) {
    const key = normalizeBusinessName(name ?? "");
    if (key) keys.add(key);
  }
  return [...keys];
}

function toRevenueCandidate(revenue: RevenueRow): RevenueCandidate {
  return {
    id: revenue.id,
    title: revenue.title,
    total_amount: revenue.total_amount,
    supply_amount: revenue.supply_amount,
    project_name: revenue.projects?.name ?? null,
    client:
      revenue.projects?.customers?.name ??
      revenue.projects?.client ??
      null,
    expected_payment_date: revenue.expected_payment_date,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function pump() {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => pump());
  await Promise.all(workers);
  return results;
}

export async function POST() {
  const { supabase, user, authUnavailable } = await requireRouteUser();
  if (!user) {
    return createRouteAuthErrorResponse(authUnavailable);
  }

  try {
    const { data: deposits, error: depositsError } = await supabase
      .from("deposits")
      .select("id, deposit_date, amount, depositor_name, memo")
      .is("revenue_id", null)
      .order("deposit_date", { ascending: false })
      .limit(500);

    if (depositsError) {
      return NextResponse.json({ error: publicErrorMessage(depositsError) }, { status: 400 });
    }

    const pendingDeposits = (deposits ?? []) as DepositRow[];

    if (pendingDeposits.length === 0) {
      return NextResponse.json({
        ok: true,
        auto_matched: [],
        ai_suggestions: [],
        unmatched: [],
        stats: { total: 0, auto: 0, ai: 0, unmatched: 0 },
      });
    }

    const { data: revenues, error: revenuesError } = await supabase
      .from("revenues")
      .select(
        "id, title, total_amount, supply_amount, expected_payment_date, projects(name, client, customers(name, account_holder))"
      )
      .eq("is_paid", false)
      .limit(1000);

    if (revenuesError) {
      return NextResponse.json({ error: publicErrorMessage(revenuesError) }, { status: 400 });
    }

    const revenueRows = (revenues ?? []) as unknown as RevenueRow[];

    // 매출별 이름 키 인덱스
    const revenueById = new Map<string, RevenueRow>();
    const revenueKeyMap = new Map<string, string[]>(); // revenue_id -> keys
    const keyToRevenueIds = new Map<string, string[]>(); // normalizedKey -> revenue_ids
    for (const rev of revenueRows) {
      revenueById.set(rev.id, rev);
      const keys = buildRevenueNameKeys(rev);
      revenueKeyMap.set(rev.id, keys);
      for (const k of keys) {
        const bucket = keyToRevenueIds.get(k);
        if (bucket) bucket.push(rev.id);
        else keyToRevenueIds.set(k, [rev.id]);
      }
    }

    // 자동 연결(입금완료 처리까지)은 입금자명과 금액이 모두 정확히 맞고, 그런 미수 매출이 하나뿐일 때만 한다.
    // 이름만 맞는 건은 금액이 달라도(수수료 차감·부분 입금·다른 건) 사람이 확인하도록 추천으로만 보여 준다.
    const autoMatched: ExactMatchResult[] = [];
    const nameOnlySuggestions: AiMatchResult[] = [];
    const aiQueue: DepositRow[] = [];
    const aiCandidateMap = new Map<string, RevenueCandidate[]>();
    // 한 번에 두 입금이 같은 매출로 자동 연결되지 않게 한다.
    const claimedRevenueIds = new Set<string>();

    for (const deposit of pendingDeposits) {
      const key = normalizeBusinessName(deposit.depositor_name);
      const matchedRevenueIds = key ? keyToRevenueIds.get(key) ?? [] : [];

      if (matchedRevenueIds.length > 0) {
        const nameMatches = matchedRevenueIds.map((id) => revenueById.get(id)!);
        const amountMatches = nameMatches.filter(
          (rev) => rev.total_amount === deposit.amount && !claimedRevenueIds.has(rev.id)
        );

        if (amountMatches.length === 1) {
          const rev = amountMatches[0];
          claimedRevenueIds.add(rev.id);
          autoMatched.push({
            deposit_id: deposit.id,
            depositor_name: deposit.depositor_name,
            amount: deposit.amount,
            deposit_date: deposit.deposit_date,
            revenue_id: rev.id,
            revenue_title: rev.title,
            revenue_amount: rev.total_amount,
            project_name: rev.projects?.name ?? null,
            match_type: "exact_name_amount",
          });
          continue;
        }

        if (nameMatches.length === 1) {
          // 이름은 하나로 맞지만 금액이 다르다 → AI 를 부르지 않고 확인용 추천으로만.
          const rev = nameMatches[0];
          nameOnlySuggestions.push({
            deposit_id: deposit.id,
            depositor_name: deposit.depositor_name,
            amount: deposit.amount,
            deposit_date: deposit.deposit_date,
            suggestions: [
              {
                revenue_id: rev.id,
                revenue_title: rev.title,
                revenue_amount: rev.total_amount,
                project_name: rev.projects?.name ?? null,
                confidence: rev.total_amount === deposit.amount ? "high" : "medium",
                reason:
                  rev.total_amount === deposit.amount
                    ? "입금자명·금액이 같지만 같은 매출에 연결될 다른 입금이 있어 확인이 필요합니다."
                    : `입금자명은 같지만 금액이 다릅니다(입금 ${deposit.amount.toLocaleString("ko-KR")}원 / 매출 ${rev.total_amount.toLocaleString("ko-KR")}원).`,
              },
            ],
          });
          continue;
        }

        // 이름은 일치하지만 금액이 모호 → 해당 후보들만 AI 에게 전달
        aiQueue.push(deposit);
        aiCandidateMap.set(deposit.id, nameMatches.map(toRevenueCandidate));
        continue;
      }

      // 이름 정확 매칭 없음 → 전체 미수 매출 중 금액 범위로 후보 압축
      const minAmount = deposit.amount * 0.5;
      const maxAmount = deposit.amount * 2;
      const candidates = revenueRows
        .filter(
          (rev) => rev.total_amount >= minAmount && rev.total_amount <= maxAmount
        )
        .slice(0, 50)
        .map(toRevenueCandidate);

      if (candidates.length === 0) {
        continue;
      }

      aiQueue.push(deposit);
      aiCandidateMap.set(deposit.id, candidates);
    }

    // 자동 연결 일괄 처리. 동시에 다른 요청(다른 사람의 일괄 매칭·수동 연결)이 같은 입금·매출을 처리해도
    // 한쪽만 반영되도록 조건부로 바꾼다.
    //  1) 매출을 "아직 미입금일 때만" 입금완료로 선점한다(0행이면 이미 처리됨 → 건너뜀).
    //  2) 입금을 "아직 연결 안 됐을 때만" 연결한다(입금 트리거가 매출 입금완료를 다시 맞춘다).
    //  3) 2)가 0행이면(다른 요청이 먼저 연결) 그 입금이 이 매출에 연결된 게 아니면 1)을 되돌린다.
    const confirmedAuto: ExactMatchResult[] = [];
    if (autoMatched.length > 0) {
      await Promise.all(
        autoMatched.map(async (match) => {
          const { data: paidRevenues, error: updateRevenueError } = await supabase
            .from("revenues")
            .update({ is_paid: true, paid_date: match.deposit_date })
            .eq("id", match.revenue_id)
            .eq("is_paid", false)
            .select("id");

          if (updateRevenueError) {
            console.error("자동 매칭 매출 업데이트 실패:", updateRevenueError.message);
            return;
          }
          if (!paidRevenues || paidRevenues.length === 0) return; // 그 사이 다른 곳에서 입금완료 처리됨

          const { data: linkedDeposits, error: updateDepositError } = await supabase
            .from("deposits")
            .update({ revenue_id: match.revenue_id })
            .eq("id", match.deposit_id)
            .is("revenue_id", null)
            .select("id");

          if (!updateDepositError && linkedDeposits && linkedDeposits.length > 0) {
            confirmedAuto.push(match);
            return;
          }

          if (updateDepositError) {
            console.error("자동 매칭 입금 업데이트 실패:", updateDepositError.message);
          }
          const { data: current } = await supabase
            .from("deposits")
            .select("revenue_id")
            .eq("id", match.deposit_id)
            .maybeSingle();
          if (current?.revenue_id !== match.revenue_id) {
            await supabase
              .from("revenues")
              .update({ is_paid: false, paid_date: null })
              .eq("id", match.revenue_id)
              .eq("is_paid", true)
              .eq("paid_date", match.deposit_date);
          }
        })
      );
    }

    // AI 매칭을 병렬 실행 (동시 3개)
    const aiResults = await runWithConcurrency(aiQueue, 3, async (deposit) => {
      const candidates = aiCandidateMap.get(deposit.id) ?? [];
      if (candidates.length === 0) {
        return null;
      }

      try {
        const suggestions = await suggestDepositRevenueMatch({
          deposit: {
            depositor_name: deposit.depositor_name,
            amount: deposit.amount,
            deposit_date: deposit.deposit_date,
            memo: deposit.memo,
          },
          revenues: candidates,
        });

        if (suggestions.length === 0) return null;

        const enriched = suggestions.map((s) => {
          const rev = candidates.find((r) => r.id === s.revenue_id);
          return {
            revenue_id: s.revenue_id,
            revenue_title: rev?.title ?? "",
            revenue_amount: rev?.total_amount ?? 0,
            project_name: rev?.project_name ?? null,
            confidence: s.confidence,
            reason: s.reason,
          };
        });

        const result: AiMatchResult = {
          deposit_id: deposit.id,
          depositor_name: deposit.depositor_name,
          amount: deposit.amount,
          deposit_date: deposit.deposit_date,
          suggestions: enriched,
        };
        return result;
      } catch (error) {
        console.error(
          `AI 매칭 실패 (deposit ${deposit.id}):`,
          error instanceof Error ? error.message : String(error)
        );
        return null;
      }
    });

    const aiSuggestions = [
      ...nameOnlySuggestions,
      ...aiResults.filter((r): r is AiMatchResult => r !== null),
    ];

    const matchedIds = new Set<string>([
      ...confirmedAuto.map((m) => m.deposit_id),
      ...aiSuggestions.map((s) => s.deposit_id),
    ]);
    const unmatched: UnmatchedDeposit[] = pendingDeposits
      .filter((d) => !matchedIds.has(d.id))
      .map((d) => ({
        deposit_id: d.id,
        depositor_name: d.depositor_name,
        amount: d.amount,
        deposit_date: d.deposit_date,
      }));

    logInfo(
      "AI_MATCH_DEPOSITS_BATCH",
      `입금 일괄 매칭: 자동 ${confirmedAuto.length}건 / AI 후보 ${aiSuggestions.length}건 / 미매칭 ${unmatched.length}건`,
      {
        resource: "deposit",
        actor_id: user.id,
        details: {
          total: pendingDeposits.length,
          auto: confirmedAuto.length,
          ai: aiSuggestions.length,
          unmatched: unmatched.length,
        },
      }
    );

    return NextResponse.json({
      ok: true,
      auto_matched: confirmedAuto,
      ai_suggestions: aiSuggestions,
      unmatched,
      stats: {
        total: pendingDeposits.length,
        auto: confirmedAuto.length,
        ai: aiSuggestions.length,
        unmatched: unmatched.length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: publicErrorMessage(error, "AI 일괄 매칭 실패") },
      { status: 500 }
    );
  }
}
