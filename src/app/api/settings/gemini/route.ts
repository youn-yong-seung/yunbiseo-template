import { createRouteAuthErrorResponse, requireRouteUser } from "@/lib/route-auth";
import { getSystemSettings } from "@/lib/system-settings";

const GEMINI_SETTING_KEYS = ["gemini_api_key"] as const;

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  const { supabase, user, authUnavailable } = await requireRouteUser();
  if (!user) {
    return createRouteAuthErrorResponse(authUnavailable);
  }
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
    api_key: settings.gemini_api_key ?? process.env.GEMINI_API_KEY ?? "",
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
  const { supabase, user, authUnavailable } = await requireRouteUser();
  if (!user) {
    return createRouteAuthErrorResponse(authUnavailable);
  }
  const body = await request.json().catch(() => null);
  const hasApiKey = body && Object.prototype.hasOwnProperty.call(body, "api_key");
  const apiKey = hasApiKey ? asTrimmedString(body?.api_key) : "";

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
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  if (hasApiKey && !apiKey) {
    const { error } = await supabase
      .from("system_settings")
      .delete()
      .in("key", ["gemini_api_key"]);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  return Response.json({ success: true });
}
