import { publicErrorMessage } from "@/lib/safe-error";

import { NextRequest, NextResponse } from "next/server";

import { getBoltaTaxInvoice, getBoltaWebhookSecret } from "@/lib/bolta";
import { logError, logInfo } from "@/lib/logger";
import { sendTaxInvoiceIssuedSlackNotification } from "@/lib/slack";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyStandardWebhook } from "@/lib/standard-webhooks";
import { appUrl } from "@/lib/app-url";


type BoltaWebhookPayload = {
  eventType?: string;
  data?: {
    issuanceKey?: string;
    taxInvoiceUrl?: string;
    cause?: {
      code?: string;
      message?: string;
    };
  };
};

/**
 * 볼타 웹훅. 볼타 문서(https://docs.bolta.io/docs/api-introduction/webhook-events)대로
 * Standard Webhooks 서명(webhook-id·webhook-timestamp·webhook-signature, HMAC-SHA256)을 확인한다.
 *
 * - 서명키: 볼타 개발자센터 > 연동 > 웹훅 > 설정의 서명키(whsec_…). 시스템 설정 화면 또는 BOLTA_WEBHOOK_SECRET.
 * - 서명키가 없으면 503(아무 요청도 받지 않음), 서명·시각이 맞지 않으면 400.
 * - 같은 webhook-id 는 한 번만 처리한다(재전송 방지). 두 번째부터는 처리 없이 200.
 */
export async function POST(request: NextRequest) {
  const configuredSecret = await getBoltaWebhookSecret();
  if (!configuredSecret) {
    return NextResponse.json(
      { error: "Bolta webhook signing secret is not configured" },
      { status: 503 }
    );
  }

  // 서명은 가공 전 원문 본문으로 확인해야 한다(JSON 으로 읽은 뒤 다시 만들면 달라진다).
  const rawBody = await request.text();
  const verified = verifyStandardWebhook(
    configuredSecret,
    {
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
    },
    rawBody,
  );
  if (!verified.ok) {
    if (verified.reason === "bad_secret") {
      logError("ERROR_BOLTA_WEBHOOK_SECRET", "볼타 웹훅 서명키 형식이 올바르지 않습니다(whsec_ 로 시작하는 값).");
      return NextResponse.json({ error: "Bolta webhook signing secret is invalid" }, { status: 503 });
    }
    return NextResponse.json({ error: "invalid_signature", reason: verified.reason }, { status: 400 });
  }

  const admin = createAdminClient();

  // 재전송 방지: 같은 webhook-id 는 한 번만 처리한다.
  await admin.from("webhook_deliveries").delete().lt("received_at", new Date(Date.now() - 86400_000).toISOString());
  const { error: deliveryError } = await admin
    .from("webhook_deliveries")
    .insert({ source: "bolta", webhook_id: verified.id });
  if (deliveryError) {
    if (deliveryError.code === "23505") {
      return NextResponse.json({ success: true, duplicate: true });
    }
    logError("ERROR_BOLTA_WEBHOOK_DELIVERY", "볼타 웹훅 수신 기록 실패", { details: { message: deliveryError.message } });
    return NextResponse.json({ error: "웹훅을 기록하지 못했습니다." }, { status: 500 });
  }

  let payload: BoltaWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as BoltaWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const response = await handleBoltaEvent(request, admin, payload);
  // 처리하지 못했으면 기록을 지워, 볼타가 같은 webhook-id 로 다시 보낼 때 다시 처리되게 한다.
  if (response.status >= 400) {
    await admin.from("webhook_deliveries").delete().eq("source", "bolta").eq("webhook_id", verified.id);
  }
  return response;
}

async function handleBoltaEvent(
  request: NextRequest,
  admin: ReturnType<typeof createAdminClient>,
  payload: BoltaWebhookPayload,
) {
  const eventType = payload.eventType ?? "";
  const issuanceKey = payload.data?.issuanceKey?.trim();

  if (!issuanceKey) {
    return NextResponse.json(
      { error: "issuanceKey is required" },
      { status: 400 }
    );
  }

  const now = new Date().toISOString();

  const { data: revenue, error: revenueError } = await admin
    .from("revenues")
    .select("id, title, tax_invoice_issuance_key")
    .eq("tax_invoice_issuance_key", issuanceKey)
    .maybeSingle();

  if (revenueError) {
    logError("ERROR_BOLTA_WEBHOOK_LOOKUP", "Bolta 웹훅 매출 조회 실패", {
      details: {
        issuance_key: issuanceKey,
        message: revenueError.message,
      },
    });

    return NextResponse.json({ error: publicErrorMessage(revenueError) }, { status: 400 });
  }

  if (!revenue) {
    logError("MISSING_BOLTA_WEBHOOK_REVENUE", "Bolta 웹훅 매출을 찾지 못했습니다.", {
      details: {
        issuance_key: issuanceKey,
        event_type: eventType,
      },
    });

    return NextResponse.json(
      { error: "Revenue not found for issuanceKey" },
      { status: 404 }
    );
  }

  const sharedPayload = {
    tax_invoice_last_webhook_at: now,
    tax_invoice_last_payload: payload,
  };

  if (eventType === "TAX_INVOICE_ISSUANCE_SUCCESS") {
    let issuedAt = now;
    let ntsTransactionId: string | null = null;

    try {
      const boltaInvoice = await getBoltaTaxInvoice(issuanceKey);
      issuedAt = boltaInvoice.issuedAt ?? issuedAt;
      ntsTransactionId = boltaInvoice.ntsTransactionId ?? null;
    } catch (error) {
      logError("ERROR_BOLTA_TAX_INVOICE_FETCH", "Bolta 세금계산서 조회 실패", {
        resource: "revenue",
        resource_id: revenue.id,
        details: {
          issuance_key: issuanceKey,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      });
    }

    const { error: updateError } = await admin
      .from("revenues")
      .update({
        ...sharedPayload,
        tax_invoice_issue_status: "issued",
        is_tax_invoice_issued: true,
        tax_invoice_date: issuedAt.slice(0, 10),
        tax_invoice_issued_at: issuedAt,
        tax_invoice_url: payload.data?.taxInvoiceUrl ?? null,
        tax_invoice_nts_transaction_id: ntsTransactionId,
        tax_invoice_error_code: null,
        tax_invoice_error_message: null,
      })
      .eq("id", revenue.id);

    if (updateError) {
      logError("ERROR_BOLTA_WEBHOOK_SUCCESS_UPDATE", "Bolta 웹훅 성공 상태 반영 실패", {
        resource: "revenue",
        resource_id: revenue.id,
        details: {
          issuance_key: issuanceKey,
          message: updateError.message,
        },
      });

      return NextResponse.json({ error: publicErrorMessage(updateError) }, { status: 400 });
    }

    logInfo("COMPLETE_REVENUE_TAX_INVOICE", `세금계산서 발행 완료: ${revenue.title}`, {
      resource: "revenue",
      resource_id: revenue.id,
      details: {
        issuance_key: issuanceKey,
        tax_invoice_url: payload.data?.taxInvoiceUrl ?? null,
      },
    });

    const revenueUrl = appUrl(request, `/dashboard/revenues/${revenue.id}`);

    try {
      await sendTaxInvoiceIssuedSlackNotification({
        revenueId: revenue.id,
        revenueUrl,
      });
    } catch (error) {
      logError("TAX_INVOICE_SLACK_NOTIFY", "세금계산서 발행 완료 Slack 알림 실패", {
        resource: "revenue",
        resource_id: revenue.id,
        details: {
          issuance_key: issuanceKey,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      });
    }

    return NextResponse.json({ success: true });
  }

  if (eventType === "TAX_INVOICE_ISSUANCE_FAILURE") {
    const errorCode = payload.data?.cause?.code ?? null;
    const errorMessage =
      payload.data?.cause?.message ?? "세금계산서 발행이 실패했습니다.";

    const { error: updateError } = await admin
      .from("revenues")
      .update({
        ...sharedPayload,
        tax_invoice_issue_status: "failed",
        is_tax_invoice_issued: false,
        tax_invoice_date: null,
        tax_invoice_issued_at: null,
        tax_invoice_url: null,
        tax_invoice_nts_transaction_id: null,
        tax_invoice_error_code: errorCode,
        tax_invoice_error_message: errorMessage,
      })
      .eq("id", revenue.id);

    if (updateError) {
      logError("ERROR_BOLTA_WEBHOOK_FAILURE_UPDATE", "Bolta 웹훅 실패 상태 반영 실패", {
        resource: "revenue",
        resource_id: revenue.id,
        details: {
          issuance_key: issuanceKey,
          message: updateError.message,
        },
      });

      return NextResponse.json({ error: publicErrorMessage(updateError) }, { status: 400 });
    }

    logError("FAIL_REVENUE_TAX_INVOICE_WEBHOOK", `세금계산서 발행 실패: ${revenue.title}`, {
      resource: "revenue",
      resource_id: revenue.id,
      details: {
        issuance_key: issuanceKey,
        code: errorCode,
        message: errorMessage,
      },
    });

    return NextResponse.json({ success: true });
  }

  logInfo("IGNORE_BOLTA_WEBHOOK", "처리 대상이 아닌 Bolta 웹훅 이벤트를 수신했습니다.", {
    resource: "revenue",
    resource_id: revenue.id,
    details: {
      issuance_key: issuanceKey,
      event_type: eventType,
    },
  });

  await admin
    .from("revenues")
    .update(sharedPayload)
    .eq("id", revenue.id);

  return NextResponse.json({ success: true, ignored: true });
}
