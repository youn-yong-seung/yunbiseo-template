import { requireRouteAdmin } from "@/lib/route-auth";
import { maskSecret, planSettingWrites } from "@/lib/secret-mask";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicErrorMessage } from "@/lib/safe-error";
import { getSystemSettings } from "@/lib/system-settings";

const BOLTA_SETTING_KEYS = [
  "bolta_api_key",
  "bolta_customer_key",
  "bolta_webhook_secret",
  "bolta_supplier_manager_email",
] as const;

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  // 외부 서비스 키 설정은 관리자만 보고 바꾼다.
  const auth = await requireRouteAdmin();
  if (!auth.ok) return auth.response;

  const settings = await getSystemSettings([...BOLTA_SETTING_KEYS]);

  return Response.json({
    api_key: maskSecret(settings.bolta_api_key ?? process.env.BOLTA_API_KEY),
    customer_key: maskSecret(settings.bolta_customer_key ?? process.env.BOLTA_CUSTOMER_KEY),
    webhook_secret: maskSecret(settings.bolta_webhook_secret ?? process.env.BOLTA_WEBHOOK_SECRET),
    supplier_manager_email:
      settings.bolta_supplier_manager_email ??
      process.env.BOLTA_SUPPLIER_MANAGER_EMAIL ??
      "",
  });
}

export async function PUT(request: Request) {
  // 외부 서비스 키 설정은 관리자만 보고 바꾼다.
  const auth = await requireRouteAdmin();
  if (!auth.ok) return auth.response;
  const supabase = createAdminClient();
  const body = (await request.json().catch(() => null)) ?? {};

  const values = {
    bolta_api_key: asTrimmedString(body.api_key),
    bolta_customer_key: asTrimmedString(body.customer_key),
    bolta_webhook_secret: asTrimmedString(body.webhook_secret),
    bolta_supplier_manager_email: asTrimmedString(body.supplier_manager_email),
  };

  const { upsertRows, deleteKeys } = planSettingWrites(values);

  if (upsertRows.length > 0) {
    const { error } = await supabase
      .from("system_settings")
      .upsert(upsertRows, { onConflict: "key" });

    if (error) {
      return Response.json({ error: publicErrorMessage(error) }, { status: 500 });
    }
  }

  if (deleteKeys.length > 0) {
    const { error } = await supabase
      .from("system_settings")
      .delete()
      .in("key", deleteKeys);

    if (error) {
      return Response.json({ error: publicErrorMessage(error) }, { status: 500 });
    }
  }

  return Response.json({ success: true });
}
