import { requireRouteAdmin } from "@/lib/route-auth";
import { maskSecret } from "@/lib/secret-mask";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicErrorMessage } from "@/lib/safe-error";
import { getSystemSettings } from "@/lib/system-settings";

const GEMINI_SETTING_KEYS = ["gemini_api_key"] as const;

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  // 외부 서비스 키 설정은 관리자만 보고 바꾼다.
  const auth = await requireRouteAdmin();
  if (!auth.ok) return auth.response;
  const supabase = createAdminClient();
  const settings = await getSystemSettings([...GEMINI_SETTING_KEYS]);

  const { data: recentLogs } = await supabase
    .from("gemini_usage_logs")
    .select("id, model, input_tokens, output_tokens, total_cost, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: cumulativeRows } = await supabase
    .from("gemini_usage_logs")
    .select("input_tokens, output_tokens, total_cost");

  let totalRequests = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;

  for (const row of cumulativeRows ?? []) {
    totalRequests += 1;
    totalInputTokens += row.input_tokens;
    totalOutputTokens += row.output_tokens;
    totalCost += Number(row.total_cost);
  }

  return Response.json({
    api_key: maskSecret(settings.gemini_api_key ?? process.env.GEMINI_API_KEY),
    usage: {
      total_requests: totalRequests,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      total_cost: totalCost,
      recent_logs: (recentLogs ?? []).map((row) => ({
        ...row,
        total_cost: Number(row.total_cost),
      })),
    },
  });
}

export async function PUT(request: Request) {
  // 외부 서비스 키 설정은 관리자만 보고 바꾼다.
  const auth = await requireRouteAdmin();
  if (!auth.ok) return auth.response;
  const supabase = createAdminClient();
  const body = await request.json().catch(() => null);
  const hasApiKey = body && Object.prototype.hasOwnProperty.call(body, "api_key");
  const apiKey = hasApiKey ? asTrimmedString(body?.api_key) : "";
  // 가린 값(••••)이 그대로 오면 바꾸지 않는다.
  if (hasApiKey && apiKey.startsWith("••••")) {
    return Response.json({ success: true });
  }

  if (hasApiKey && apiKey) {
    const { error } = await supabase
      .from("system_settings")
      .upsert(
        [
          {
            key: "gemini_api_key",
            value: apiKey,
            updated_at: new Date().toISOString(),
          },
        ],
        { onConflict: "key" }
      );

    if (error) {
      return Response.json({ error: publicErrorMessage(error) }, { status: 500 });
    }
  }

  if (hasApiKey && !apiKey) {
    const { error } = await supabase
      .from("system_settings")
      .delete()
      .in("key", ["gemini_api_key"]);

    if (error) {
      return Response.json({ error: publicErrorMessage(error) }, { status: 500 });
    }
  }

  return Response.json({ success: true });
}
