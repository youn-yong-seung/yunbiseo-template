import { randomUUID } from "crypto";
import { isPublicErrorMessage, publicErrorMessage } from "@/lib/safe-error";
import { NextResponse } from "next/server";

import {
  BoltaApiError,
  getBoltaCustomerKey,
  getBoltaIssueStatus,
  getBoltaTaxInvoice,
  issueBoltaTaxInvoice,
  type BoltaTaxInvoiceIssueRequest,
} from "@/lib/bolta";
import { logError, logInfo } from "@/lib/logger";
import { DEFAULT_SUPPLIER } from "@/lib/quotation-constants";
import {
  REVENUE_TAX_INVOICE_STALE_MINUTES,
  getRevenueTaxInvoiceState,
  isRevenueTaxInvoiceIssuingStale,
} from "@/lib/revenue-tax-invoice";
import { canManageFinance, forbiddenResponse, requireRouteUserOrApiKey } from "@/lib/route-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSystemSettingWithEnvFallback } from "@/lib/system-settings";
import {
  getTaxInvoicePreviewMissingFields,
  mergeTaxInvoicePreview,
} from "@/lib/tax-invoice-preview";
import type { Customer, CustomerContact, Revenue } from "@/lib/types";

type RouteContext = { params: Promise<{ id: string }> };

type RevenueIssueRecord = Pick<
  Revenue,
  | "id"
  | "project_id"
  | "title"
  | "product_name"
  | "memo"
  | "revenue_date"
  | "is_paid"
  | "is_tax_invoice_issued"
  | "tax_invoice_not_required"
  | "tax_invoice_issue_status"
  | "tax_invoice_client_reference_id"
  | "tax_invoice_issuance_key"
  | "tax_invoice_issue_requested_at"
  | "tax_invoice_last_webhook_at"
  | "tax_invoice_date"
  | "tax_invoice_issued_at"
  | "tax_invoice_url"
  | "tax_invoice_nts_transaction_id"
  | "tax_invoice_error_code"
  | "tax_invoice_error_message"
  | "supply_amount"
  | "vat_amount"
>;

type TaxInvoiceMutationAction = "sync" | "force-reset";

type ProjectRecord = {
  id: string;
  name: string;
  project_number: string;
  customer_id: string | null;
};

type CustomerRecord = Pick<
  Customer,
  | "id"
  | "name"
  | "representative_name"
  | "business_number"
  | "address"
  | "contact_name"
  | "contact_email"
  | "contact_phone"
>;

type CustomerContactRecord = Pick<CustomerContact, "name" | "email" | "phone">;

type EmployeeContactRecord = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

type SupplierContact = {
  name: string;
  email: string | null;
  phone: string | null;
};

type PrepareIssuePreviewResult = {
  preview: BoltaTaxInvoiceIssueRequest;
  missingFields: string[];
  structuralBlockedReasons: string[];
};

function compactJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asTrimmed(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeBusinessNumber(value: string | null | undefined) {
  return (value ?? "").replace(/\D/g, "");
}

function makeClientReferenceId(revenueId: string) {
  const compactId = revenueId.replace(/-/g, "");
  return `revenue_${compactId.slice(0, 16)}_${randomUUID().slice(0, 8)}`;
}

function getStateBlockedReasons(taxInvoiceState: string) {
  if (taxInvoiceState === "not_required") {
    return ["세금계산서 발행 대상이 아닌 매출입니다."];
  }

  if (taxInvoiceState === "issued") {
    return ["이미 세금계산서가 발행된 매출입니다."];
  }

  if (taxInvoiceState === "issuing") {
    return ["세금계산서 발행이 진행 중입니다."];
  }

  return [];
}

/**
 * 요청 본문으로 바꿀 수 없는 칸을 서버 값으로 되돌린다.
 * - 품목 수·수량·단가·공급가액·세액: 매출에 저장된 금액에서만 나온다(본문으로 금액을 바꿔 발행하지 못하게).
 * - 공급자(우리 회사) 사업자번호·상호·대표자: 서버에 설정돼 있으면(quotation-constants) 그 값만 쓴다.
 *   설정이 비어 있는 템플릿 기본 상태에서는 화면에서 넣은 값을 쓴다.
 * - 공급받는자 사업자번호·상호: 연결된 고객 레코드 값만 쓴다(비어 있으면 prepareIssuePreview 가 발행을 막는다).
 *   대표자는 고객 레코드에 있으면 그 값, 없을 때만 화면 값을 받는다.
 * - 공급받는자 담당자 이메일: 고객 레코드(대표 연락처·담당자)에 있으면 그 값만 쓴다. 없으면 화면 값을 받는다.
 *   이메일은 세금계산서를 받을 주소일 뿐 국세청에 신고되는 거래 상대(사업자번호·상호)를 바꾸지 않고,
 *   고객마다 이메일을 미리 넣어 두지 않은 경우가 많아 막으면 정상 발행이 멈춘다. 발행 권한(관리자·재무)이 있는 사람만 넣을 수 있다.
 * 날짜·용도·설명·품목명, 담당자 이름·전화처럼 비어 있으면 채워야 하는 칸은 화면 값을 받는다.
 */
function lockServerTaxInvoiceFields(
  merged: BoltaTaxInvoiceIssueRequest,
  server: BoltaTaxInvoiceIssueRequest
): BoltaTaxInvoiceIssueRequest {
  return {
    ...merged,
    supplier: {
      ...merged.supplier,
      identificationNumber: server.supplier.identificationNumber || merged.supplier.identificationNumber,
      organizationName: server.supplier.organizationName || merged.supplier.organizationName,
      representativeName: server.supplier.representativeName || merged.supplier.representativeName,
    },
    supplied: {
      ...merged.supplied,
      identificationNumber: server.supplied.identificationNumber,
      organizationName: server.supplied.organizationName,
      representativeName: server.supplied.representativeName || merged.supplied.representativeName,
      managers: (merged.supplied.managers?.length ? merged.supplied.managers : server.supplied.managers).map(
        (manager, index) => {
          const serverEmail = server.supplied.managers?.[index]?.email || server.supplied.managers?.[0]?.email;
          return { ...manager, email: serverEmail || manager.email };
        }
      ),
    },
    items: server.items.map((serverItem, index) => {
      const edited = merged.items[index] ?? serverItem;
      return {
        ...edited,
        quantity: serverItem.quantity,
        unitPrice: serverItem.unitPrice,
        supplyCost: serverItem.supplyCost,
        tax: serverItem.tax,
      };
    }),
  };
}

function getPreviewOverride(body: unknown) {
  if (!body || typeof body !== "object" || !("preview" in body)) {
    return null;
  }

  return (body as { preview?: unknown }).preview ?? null;
}

function getPatchAction(body: unknown): TaxInvoiceMutationAction | null {
  if (!body || typeof body !== "object" || !("action" in body)) {
    return null;
  }

  const action = (body as { action?: unknown }).action;
  if (action === "sync" || action === "force-reset") {
    return action;
  }

  return null;
}

function hasTaxInvoiceTrackingInfo(revenue: RevenueIssueRecord) {
  return Boolean(
    asTrimmed(revenue.tax_invoice_client_reference_id) ||
    asTrimmed(revenue.tax_invoice_issuance_key)
  );
}

function isBoltaNotFoundError(error: unknown) {
  return error instanceof BoltaApiError && error.status === 404;
}

async function selectUpdatedRevenue(revenueId: string) {
  return selectRevenueWithProject(revenueId);
}

async function syncRevenueTaxInvoiceStatus(revenue: RevenueIssueRecord) {
  const admin = createAdminClient();
  const taxInvoiceState = getRevenueTaxInvoiceState(revenue);

  if (taxInvoiceState === "issued" || taxInvoiceState === "not_required") {
    return {
      resolved: false,
      message: "현재 상태에서는 세금계산서 재확인이 필요하지 않습니다.",
      data: await selectUpdatedRevenue(revenue.id),
    };
  }

  let issuanceKey = asTrimmed(revenue.tax_invoice_issuance_key);
  let statusMessage: string | null = null;
  const clientReferenceId = asTrimmed(revenue.tax_invoice_client_reference_id);

  if (!issuanceKey) {
    if (!clientReferenceId) {
      return {
        resolved: false,
        message: "발행 추적 정보가 없어 Bolta 상태를 재확인할 수 없습니다.",
        data: await selectUpdatedRevenue(revenue.id),
      };
    }

    try {
      const issueStatus = await getBoltaIssueStatus(clientReferenceId);
      issuanceKey = asTrimmed(issueStatus.issuanceKey);
      statusMessage = asTrimmed(issueStatus.message);

      if (issuanceKey) {
        const { error: updateError } = await admin
          .from("revenues")
          .update({
            tax_invoice_issuance_key: issuanceKey,
            tax_invoice_error_code: null,
            tax_invoice_error_message: null,
          })
          .eq("id", revenue.id);

        if (updateError) {
          throw new Error(updateError.message);
        }
      }
    } catch (error) {
      if (isBoltaNotFoundError(error)) {
        return {
          resolved: false,
          message: "Bolta에서 아직 발행 추적 정보를 찾지 못했습니다. 조금 더 기다린 뒤 다시 확인하세요.",
          data: await selectUpdatedRevenue(revenue.id),
        };
      }

      throw error;
    }
  }

  if (!issuanceKey) {
    return {
      resolved: false,
      message:
        (statusMessage && isPublicErrorMessage(statusMessage) ? statusMessage : null) ??
        "Bolta에서 아직 발행 키를 반환하지 않았습니다.",
      data: await selectUpdatedRevenue(revenue.id),
    };
  }

  try {
    const boltaInvoice = await getBoltaTaxInvoice(issuanceKey);
    const issuedAt = boltaInvoice.issuedAt ?? new Date().toISOString();

    const { error: updateError } = await admin
      .from("revenues")
      .update({
        tax_invoice_issue_status: "issued",
        is_tax_invoice_issued: true,
        tax_invoice_issuance_key: issuanceKey,
        tax_invoice_date: issuedAt.slice(0, 10),
        tax_invoice_issued_at: issuedAt,
        tax_invoice_nts_transaction_id: boltaInvoice.ntsTransactionId ?? null,
        tax_invoice_error_code: null,
        tax_invoice_error_message: null,
      })
      .eq("id", revenue.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return {
      resolved: true,
      message: "Bolta 상태를 다시 확인해 발행 완료로 반영했습니다.",
      data: await selectUpdatedRevenue(revenue.id),
    };
  } catch (error) {
    if (isBoltaNotFoundError(error)) {
      return {
        resolved: false,
        message:
          statusMessage ??
          "아직 Bolta 확정 결과를 확인하지 못했습니다. 조금 더 기다리거나 발행중 해제를 진행하세요.",
        data: await selectUpdatedRevenue(revenue.id),
      };
    }

    throw error;
  }
}

async function resolveSupplierContact() {
  const admin = createAdminClient();
  const managerName = DEFAULT_SUPPLIER.supplier_manager;

  const { data } = await admin
    .from("employees")
    .select("name, email, phone")
    .eq("name", managerName)
    .eq("is_active", true)
    .maybeSingle();

  const employee = (data as EmployeeContactRecord | null) ?? null;

  return {
    name: managerName,
    email:
      asTrimmed(await getSystemSettingWithEnvFallback("bolta_supplier_manager_email", "BOLTA_SUPPLIER_MANAGER_EMAIL")) ??
        asTrimmed(employee?.email),
    phone:
      asTrimmed(employee?.phone) ??
      asTrimmed(DEFAULT_SUPPLIER.supplier_phone),
  } satisfies SupplierContact;
}

function pickPrimaryContact(
  customer: CustomerRecord | null,
  contacts: CustomerContactRecord[]
) {
  const firstWithEmail = contacts.find((contact) => asTrimmed(contact.email));
  const firstWithPhone = contacts.find((contact) => asTrimmed(contact.phone));
  const firstWithName = contacts.find((contact) => asTrimmed(contact.name));

  return {
    representativeName:
      asTrimmed(customer?.representative_name) ??
      asTrimmed(customer?.contact_name) ??
      asTrimmed(firstWithName?.name) ??
      asTrimmed(customer?.name) ??
      "",
    managerName:
      asTrimmed(customer?.contact_name) ??
      asTrimmed(firstWithName?.name) ??
      asTrimmed(customer?.representative_name) ??
      asTrimmed(customer?.name) ??
      "",
    email:
      asTrimmed(customer?.contact_email) ??
      asTrimmed(firstWithEmail?.email),
    phone:
      asTrimmed(customer?.contact_phone) ??
      asTrimmed(firstWithPhone?.phone),
  };
}

function buildIssuePreview(args: {
  revenue: RevenueIssueRecord;
  project: ProjectRecord | null;
  customer: CustomerRecord | null;
  contacts: CustomerContactRecord[];
  supplierContact: SupplierContact;
}) {
  const { revenue, project, customer, contacts, supplierContact } = args;
  const recipient = pickPrimaryContact(customer, contacts);
  const supplierBusinessNumber = normalizeBusinessNumber(
    DEFAULT_SUPPLIER.supplier_business_number
  );
  const customerBusinessNumber = normalizeBusinessNumber(customer?.business_number);
  const today = new Date().toISOString().slice(0, 10);
  const itemDate = revenue.revenue_date ?? today;
  const itemName = asTrimmed(revenue.product_name) ?? asTrimmed(revenue.title) ?? "";

  return compactJson({
    date: today,
    purpose: revenue.is_paid ? "RECEIPT" : "CLAIM",
    supplier: {
      identificationNumber: supplierBusinessNumber,
      organizationName: DEFAULT_SUPPLIER.supplier_name,
      representativeName: DEFAULT_SUPPLIER.supplier_representative,
      address: asTrimmed(DEFAULT_SUPPLIER.supplier_address) ?? undefined,
      businessItem: asTrimmed(DEFAULT_SUPPLIER.supplier_business_category) ?? undefined,
      businessType: asTrimmed(DEFAULT_SUPPLIER.supplier_business_type) ?? undefined,
      manager: {
        email: supplierContact.email ?? "",
        name: supplierContact.name,
        telephone: supplierContact.phone ?? undefined,
      },
    },
    supplied: {
      identificationNumber: customerBusinessNumber,
      organizationName: customer?.name ?? "",
      representativeName: recipient.representativeName,
      address: asTrimmed(customer?.address) ?? undefined,
      managers: [
        {
          email: recipient.email ?? "",
          name: recipient.managerName,
          telephone: recipient.phone ?? undefined,
        },
      ],
    },
    items: [
      {
        date: itemDate,
        name: itemName,
        quantity: 1,
        unitPrice: revenue.supply_amount,
        supplyCost: revenue.supply_amount,
        tax: revenue.vat_amount > 0 ? revenue.vat_amount : undefined,
        description: asTrimmed(revenue.memo) ?? undefined,
      },
    ],
    description: project
      ? `${project.project_number} ${project.name}`.trim()
      : revenue.title,
  } satisfies BoltaTaxInvoiceIssueRequest);
}

async function selectRevenue(revenueId: string) {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("revenues")
    .select(
      [
        "id",
        "project_id",
        "title",
        "product_name",
        "memo",
        "revenue_date",
        "is_paid",
        "is_tax_invoice_issued",
        "tax_invoice_not_required",
        "tax_invoice_issue_status",
        "tax_invoice_client_reference_id",
        "tax_invoice_issuance_key",
        "tax_invoice_issue_requested_at",
        "tax_invoice_last_webhook_at",
        "tax_invoice_date",
        "tax_invoice_issued_at",
        "tax_invoice_url",
        "tax_invoice_nts_transaction_id",
        "tax_invoice_error_code",
        "tax_invoice_error_message",
        "supply_amount",
        "vat_amount",
      ].join(", ")
    )
    .eq("id", revenueId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as RevenueIssueRecord | null) ?? null;
}

async function selectProject(projectId: string) {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("projects")
    .select("id, name, project_number, customer_id")
    .eq("id", projectId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as ProjectRecord | null) ?? null;
}

async function selectCustomer(customerId: string) {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("customers")
    .select(
      "id, name, representative_name, business_number, address, contact_name, contact_email, contact_phone"
    )
    .eq("id", customerId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as CustomerRecord | null) ?? null;
}

async function selectCustomerContacts(customerId: string) {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("customer_contacts")
    .select("name, email, phone")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data as CustomerContactRecord[] | null) ?? [];
}

async function selectRevenueWithProject(revenueId: string) {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("revenues")
    .select(`
      *,
      projects(
        id,
        project_number,
        name,
        customer_id,
        client,
        description,
        status,
        start_date,
        end_date,
        manager,
        customers(
          id,
          name,
          customer_type,
          representative_name,
          business_number,
          contact_name,
          contact_email,
          contact_phone,
          address,
          memo
        )
      )
    `)
    .eq("id", revenueId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function prepareIssuePreview(
  revenue: RevenueIssueRecord
): Promise<PrepareIssuePreviewResult> {
  const project = revenue.project_id ? await selectProject(revenue.project_id) : null;
  const customer =
    project?.customer_id ? await selectCustomer(project.customer_id) : null;
  const contacts =
    project?.customer_id ? await selectCustomerContacts(project.customer_id) : [];
  const supplierContact = await resolveSupplierContact();
  const preview = buildIssuePreview({
    revenue,
    project,
    customer,
    contacts,
    supplierContact,
  });
  const structuralBlockedReasons: string[] = [];

  if (!revenue.project_id || !project) {
    structuralBlockedReasons.push("연결된 프로젝트가 없습니다.");
  }

  if (!project?.customer_id || !customer) {
    structuralBlockedReasons.push("연결된 고객이 없습니다.");
  } else {
    // 공급받는자 사업자번호·상호는 고객 레코드 값만 쓴다(화면에서 바꿔 다른 사업자로 발행하지 못하게).
    if (normalizeBusinessNumber(customer.business_number).length !== 10) {
      structuralBlockedReasons.push("고객의 사업자등록번호(10자리)가 비어 있거나 올바르지 않습니다. 고객 정보에서 먼저 입력하세요.");
    }
    if (!asTrimmed(customer.name)) {
      structuralBlockedReasons.push("고객 상호가 비어 있습니다. 고객 정보에서 먼저 입력하세요.");
    }
  }

  if (
    !(await getSystemSettingWithEnvFallback("bolta_api_key", "BOLTA_API_KEY"))
  ) {
    structuralBlockedReasons.push("볼타 API 키가 없어 자동 발행을 쓸 수 없습니다. 시스템 설정에서 볼타를 연결하거나, 홈택스에서 직접 발행한 뒤 매출 수정에서 '세금계산서 발행완료'를 체크하세요.");
  }

  if (
    !(await getSystemSettingWithEnvFallback("bolta_customer_key", "BOLTA_CUSTOMER_KEY"))
  ) {
    structuralBlockedReasons.push("볼타 Customer Key가 없어 자동 발행을 쓸 수 없습니다.");
  }

  return {
    preview,
    missingFields: getTaxInvoicePreviewMissingFields(preview),
    structuralBlockedReasons: [...new Set(structuralBlockedReasons)],
  };
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await requireRouteUserOrApiKey(request);
  if (!auth.ok) return auth.response;

  try {
    const { id } = await context.params;
    const revenue = await selectRevenue(id);

    if (!revenue) {
      return NextResponse.json({ error: "Revenue not found" }, { status: 404 });
    }

    const taxInvoiceState = getRevenueTaxInvoiceState(revenue);
    const { preview, missingFields, structuralBlockedReasons } =
      await prepareIssuePreview(revenue);
    const nonEditableBlockedReasons = [
      ...getStateBlockedReasons(taxInvoiceState),
      ...structuralBlockedReasons,
    ];
    const blockedReasons = [...nonEditableBlockedReasons, ...missingFields];

    return NextResponse.json({
      success: true,
      canIssue: blockedReasons.length === 0,
      taxInvoiceState,
      missingFields,
      blockedReasons,
      nonEditableBlockedReasons,
      preview,
    });
  } catch (error) {
    const message =
      publicErrorMessage(error, "서버 오류가 발생했습니다.");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireRouteUserOrApiKey(request);
  if (!auth.ok) return auth.response;
  const actorId = auth.actorId ?? undefined;

  const { id } = await context.params;
  const admin = createAdminClient();

  try {
    const revenue = await selectRevenue(id);
    if (!revenue) {
      return NextResponse.json({ error: "Revenue not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    const action = getPatchAction(body);

    if (!action) {
      return NextResponse.json(
        { error: "지원하지 않는 세금계산서 작업입니다." },
        { status: 400 }
      );
    }

    if (action === "sync") {
      if (!hasTaxInvoiceTrackingInfo(revenue)) {
        return NextResponse.json(
          { error: "발행 추적 정보가 없어 Bolta 상태를 재확인할 수 없습니다." },
          { status: 400 }
        );
      }

      const result = await syncRevenueTaxInvoiceStatus(revenue);

      logInfo(
        result.resolved ? "SYNC_REVENUE_TAX_INVOICE_SUCCESS" : "SYNC_REVENUE_TAX_INVOICE_PENDING",
        result.resolved
          ? `세금계산서 상태 수동 복구: ${revenue.title}`
          : `세금계산서 상태 재확인 대기: ${revenue.title}`,
        {
          resource: "revenue",
          resource_id: revenue.id,
          actor_id: actorId,
          details: {
            resolved: result.resolved,
            issuance_key: revenue.tax_invoice_issuance_key,
            client_reference_id: revenue.tax_invoice_client_reference_id,
            message: result.message,
          },
        }
      );

      return NextResponse.json({
        success: true,
        resolved: result.resolved,
        message: result.message,
        data: result.data,
        stale: isRevenueTaxInvoiceIssuingStale(revenue),
      });
    }

    // 강제 취소는 발행과 같은 권한(관리자·재무). API 키는 키 주인 직원의 권한으로 본다.
    if (!canManageFinance(auth.actor.employee)) {
      return forbiddenResponse("세금계산서 발행중 강제 취소는 관리자 또는 재무 담당만 할 수 있습니다.");
    }

    if (getRevenueTaxInvoiceState(revenue) !== "issuing") {
      return NextResponse.json(
        { error: "발행중 상태인 세금계산서만 강제 취소할 수 있습니다." },
        { status: 409 }
      );
    }

    const ageMinutes =
      revenue.tax_invoice_issue_requested_at
        ? Math.max(
            0,
            Math.floor(
              (Date.now() -
                new Date(revenue.tax_invoice_issue_requested_at).getTime()) /
                60_000
            )
          )
        : null;
    // 방금 볼타로 보낸 건을 바로 풀면 같은 매출을 두 번 발행할 수 있다. 오래 걸린(멈춘) 건만 풀어 준다.
    // 요청 시각이 없는 옛 데이터는 경과 시간을 알 수 없어 풀어 준다(그대로 두면 영원히 발행중으로 남는다).
    if (ageMinutes !== null && ageMinutes < REVENUE_TAX_INVOICE_STALE_MINUTES) {
      return NextResponse.json(
        {
          error: `발행 요청 후 ${REVENUE_TAX_INVOICE_STALE_MINUTES}분이 지나야 강제 취소할 수 있습니다. 먼저 '상태 재확인'을 눌러 보세요.`,
        },
        { status: 409 }
      );
    }

    const errorMessage =
      "사용자가 발행중 상태를 강제 취소했습니다. 볼타 관리자 화면에서 실제 발행 여부를 반드시 확인하세요. " +
      "웹훅이 뒤늦게 도착해 실제로는 발행이 완료될 수 있으며, 이 경우 상태 정합성이 맞지 않을 수 있습니다.";

    // 읽은 뒤 웹훅이 발행완료로 바꿨거나 다른 요청이 새로 발행을 시작했으면 0행(409).
    let resetQuery = admin
      .from("revenues")
      .update({
        tax_invoice_issue_status: "failed",
        is_tax_invoice_issued: false,
        tax_invoice_date: null,
        tax_invoice_issued_at: null,
        tax_invoice_url: null,
        tax_invoice_nts_transaction_id: null,
        tax_invoice_error_code: "FORCE_CANCELLED",
        tax_invoice_error_message: errorMessage,
      })
      .eq("id", revenue.id)
      .eq("tax_invoice_issue_status", "issuing")
      .not("is_tax_invoice_issued", "is", true);
    const readReferenceId = revenue.tax_invoice_client_reference_id;
    resetQuery = readReferenceId
      ? resetQuery.eq("tax_invoice_client_reference_id", readReferenceId)
      : resetQuery.is("tax_invoice_client_reference_id", null);
    const { data: resetRows, error: resetError } = await resetQuery.select("id");

    if (resetError) {
      throw new Error(resetError.message);
    }
    if (!resetRows || resetRows.length === 0) {
      return NextResponse.json(
        { error: "그 사이 세금계산서 상태가 바뀌었습니다. 새로 고침한 뒤 다시 확인하세요.", data: await selectUpdatedRevenue(revenue.id) },
        { status: 409 }
      );
    }

    logError("FORCE_CANCEL_REVENUE_TAX_INVOICE", `세금계산서 발행 강제 취소: ${revenue.title}`, {
      resource: "revenue",
      resource_id: revenue.id,
      actor_id: actorId,
      details: {
        issuance_key: revenue.tax_invoice_issuance_key,
        client_reference_id: revenue.tax_invoice_client_reference_id,
        requested_at: revenue.tax_invoice_issue_requested_at,
        age_minutes: ageMinutes,
      },
    });

    return NextResponse.json({
      success: true,
      resolved: true,
      message: errorMessage,
      data: await selectUpdatedRevenue(revenue.id),
    });
  } catch (error) {
    const message =
      publicErrorMessage(error, "서버 오류가 발생했습니다.");

    logError("ERROR_REVENUE_TAX_INVOICE_PATCH", `세금계산서 상태 복구 API 오류: ${id}`, {
      resource: "revenue",
      resource_id: id,
      actor_id: actorId,
      details: {
        message,
      },
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const auth = await requireRouteUserOrApiKey(request);
  if (!auth.ok) return auth.response;
  const actorId = auth.actorId ?? undefined;

  // 세금계산서 발행은 관리자·재무만. API 키는 키 주인 직원의 권한으로 본다.
  if (!canManageFinance(auth.actor.employee)) {
    return forbiddenResponse("세금계산서 발행은 관리자 또는 재무 담당만 할 수 있습니다.");
  }

  const { id } = await context.params;
  const admin = createAdminClient();

  try {
    const revenue = await selectRevenue(id);
    if (!revenue) {
      return NextResponse.json({ error: "Revenue not found" }, { status: 404 });
    }

    const taxInvoiceState = getRevenueTaxInvoiceState(revenue);
    if (taxInvoiceState === "not_required") {
      return NextResponse.json(
        { error: "세금계산서 발행 대상이 아닌 매출입니다." },
        { status: 400 }
      );
    }

    if (taxInvoiceState === "issued") {
      return NextResponse.json(
        { error: "이미 세금계산서가 발행된 매출입니다." },
        { status: 409 }
      );
    }

    if (taxInvoiceState === "issuing") {
      const current = await selectRevenueWithProject(id);
      return NextResponse.json(
        {
          error: "세금계산서 발행이 진행 중입니다.",
          data: current,
        },
        { status: 409 }
      );
    }

    const requestBody = (await request.json().catch(() => null)) as
      | { preview?: unknown }
      | null;
    const { preview: basePreview, structuralBlockedReasons } =
      await prepareIssuePreview(revenue);

    if (structuralBlockedReasons.length > 0) {
      return NextResponse.json(
        {
          error: "발행 준비가 완료되지 않았습니다.",
          blockedReasons: structuralBlockedReasons,
          nonEditableBlockedReasons: structuralBlockedReasons,
          preview: basePreview,
        },
        { status: 400 }
      );
    }

    // 화면에서 고친 값은 설명·연락처 같은 칸만 받는다. 금액·수량·품목 수·공급자 사업자 정보는 서버 값만 쓴다.
    const preview = lockServerTaxInvoiceFields(
      mergeTaxInvoicePreview(basePreview, getPreviewOverride(requestBody)),
      basePreview
    );
    const missingFields = getTaxInvoicePreviewMissingFields(preview);

    if (missingFields.length > 0) {
      return NextResponse.json(
        {
          error: "필수 발행 정보가 누락되어 세금계산서를 발행할 수 없습니다.",
          missingFields,
          blockedReasons: missingFields,
          nonEditableBlockedReasons: [],
          preview,
        },
        { status: 400 }
      );
    }

    const clientReferenceId = makeClientReferenceId(revenue.id);
    const issueRequestedAt = new Date().toISOString();

    // 발행 전에 상태를 먼저 "발행중"으로 선점한다. 발행중·발행완료·발행불필요가 아닌 행만 바뀌므로
    // 동시에 두 번 눌러도 한 요청만 볼타로 간다(0행이면 409).
    const { data: claimed, error: pendingError } = await admin
      .from("revenues")
      .update({
        tax_invoice_issue_status: "issuing",
        tax_invoice_client_reference_id: clientReferenceId,
        tax_invoice_issue_requested_at: issueRequestedAt,
        tax_invoice_issuance_key: null,
        tax_invoice_error_code: null,
        tax_invoice_error_message: null,
        tax_invoice_request_payload: preview,
      })
      .eq("id", revenue.id)
      .or("tax_invoice_issue_status.is.null,tax_invoice_issue_status.not.in.(issuing,issued)")
      .not("is_tax_invoice_issued", "is", true)
      .not("tax_invoice_not_required", "is", true)
      .select("id");

    if (pendingError) {
      throw new Error(pendingError.message);
    }
    if (!claimed || claimed.length === 0) {
      return NextResponse.json(
        { error: "세금계산서 발행이 이미 진행 중이거나 끝났습니다.", data: await selectRevenueWithProject(id) },
        { status: 409 }
      );
    }

    try {
      const issueResponse = await issueBoltaTaxInvoice(preview, {
        customerKey: await getBoltaCustomerKey(),
        clientReferenceId,
      });

      const { error: updateError } = await admin
        .from("revenues")
        .update({
          tax_invoice_issue_status: "issuing",
          tax_invoice_issuance_key: issueResponse.issuanceKey,
          tax_invoice_error_code: null,
          tax_invoice_error_message: null,
        })
        .eq("id", revenue.id)
        // 이 요청이 선점한 "발행중"일 때만. 그 사이 웹훅이 발행완료로 바꿨거나 강제 취소됐으면 덮어쓰지 않는다.
        .eq("tax_invoice_issue_status", "issuing")
        .eq("tax_invoice_client_reference_id", clientReferenceId);

      if (updateError) {
        throw new Error(updateError.message);
      }

      logInfo("ISSUE_REVENUE_TAX_INVOICE", `세금계산서 발행 요청: ${revenue.title}`, {
        resource: "revenue",
        resource_id: revenue.id,
        actor_id: actorId,
        details: {
          client_reference_id: clientReferenceId,
          issuance_key: issueResponse.issuanceKey,
        },
      });

      const updatedRevenue = await selectRevenueWithProject(revenue.id);

      return NextResponse.json(
        {
          success: true,
          data: updatedRevenue,
        },
        { status: 202 }
      );
    } catch (error) {
      if (error instanceof BoltaApiError) {
        try {
          const issueStatus = await getBoltaIssueStatus(clientReferenceId);

          const { error: recoveredUpdateError } = await admin
            .from("revenues")
            .update({
              tax_invoice_issue_status: "issuing",
              tax_invoice_issuance_key: issueStatus.issuanceKey,
              tax_invoice_error_code: null,
              tax_invoice_error_message: null,
            })
            .eq("id", revenue.id)
            .eq("tax_invoice_issue_status", "issuing")
            .eq("tax_invoice_client_reference_id", clientReferenceId);

          if (recoveredUpdateError) {
            throw new Error(recoveredUpdateError.message);
          }

          logInfo(
            "RECOVER_REVENUE_TAX_INVOICE",
            `세금계산서 발행 상태 복구: ${revenue.title}`,
            {
              resource: "revenue",
              resource_id: revenue.id,
              actor_id: actorId,
              details: {
                client_reference_id: clientReferenceId,
                issuance_key: issueStatus.issuanceKey,
                message: issueStatus.message,
              },
            }
          );

          const updatedRevenue = await selectRevenueWithProject(revenue.id);

          return NextResponse.json(
            {
              success: true,
              data: updatedRevenue,
            },
            { status: 202 }
          );
        } catch {
          // Fall through to failed status update below.
        }
      }

      const errorCode = error instanceof BoltaApiError ? error.code : null;
      // 볼타가 준 한국어 안내는 보여 주고, DB·네트워크 오류 원문은 서버 로그에만 남긴다.
      const errorMessage = publicErrorMessage(error, "세금계산서 발행 요청 중 오류가 발생했습니다.");

      // 선점한 "발행중"을 실패로 되돌린다(이 요청이 선점한 건만).
      await admin
        .from("revenues")
        .update({
          tax_invoice_issue_status: "failed",
          tax_invoice_issuance_key: null,
          tax_invoice_error_code: errorCode,
          tax_invoice_error_message: errorMessage,
        })
        .eq("id", revenue.id)
        .eq("tax_invoice_client_reference_id", clientReferenceId)
        .eq("tax_invoice_issue_status", "issuing");

      logError("FAIL_REVENUE_TAX_INVOICE", `세금계산서 발행 요청 실패: ${revenue.title}`, {
        resource: "revenue",
        resource_id: revenue.id,
        actor_id: actorId,
        details: {
          client_reference_id: clientReferenceId,
          code: errorCode,
          message: errorMessage,
        },
      });

      return NextResponse.json(
        { error: errorMessage },
        { status: error instanceof BoltaApiError ? error.status : 500 }
      );
    }
  } catch (error) {
    const message =
      publicErrorMessage(error, "서버 오류가 발생했습니다.");

    logError("ERROR_REVENUE_TAX_INVOICE", `세금계산서 발행 API 오류: ${id}`, {
      resource: "revenue",
      resource_id: id,
      actor_id: actorId,
      details: {
        message,
      },
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
