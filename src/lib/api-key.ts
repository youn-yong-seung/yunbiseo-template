import { createHash, randomBytes } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { toRouteEmployee, type RouteEmployee } from "@/lib/route-auth";

const KEY_PREFIX = "ys_";
const KEY_LENGTH = 40;

export function generateApiKey(): string {
  const random = randomBytes(32).toString("hex");
  return (KEY_PREFIX + random).slice(0, KEY_LENGTH);
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function getKeyPrefix(key: string): string {
  return key.slice(0, 12) + "...";
}

function extractApiKey(request: Request): string {
  const headerKey = request.headers.get("x-api-key");
  if (headerKey) return headerKey.trim();

  const authHeader = request.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  return "";
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** 키 주인 직원의 지금 이름 (기록·표시용) */
  created_by: string;
  employee_id: string;
  employee: RouteEmployee;
}

type ApiKeyRow = {
  id: string;
  name: string;
  employee_id: string | null;
  expires_at: string | null;
  employees: {
    id: string;
    name: string;
    employee_type: string | null;
    is_finance: boolean | null;
    auth_uid: string | null;
    is_active: boolean | null;
  } | null;
};

/**
 * 요청의 API 키(x-api-key 또는 Authorization: Bearer)를 확인하고 키 주인 직원을 돌려준다.
 *
 * - DB 에는 sha256 해시만 있다. 원문 키는 비교에 쓰고 버린다.
 * - 폐기된 키(is_active=false), 만료된 키, 주인이 없는 키, 주인 직원이 비활성인 키는 거부한다.
 * - 환경변수로 만든 "주인 없는 공용 키"는 받지 않는다(누가 한 일인지 알 수 없고 권한을 좁힐 수 없다).
 */
export async function validateApiKeyRecord(request: Request): Promise<ApiKeyRecord | null> {
  const key = extractApiKey(request);
  if (!key || key.length > 200) return null;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, name, employee_id, expires_at, employees!api_keys_employee_id_fkey(id, name, employee_type, is_finance, auth_uid, is_active)")
    .eq("key_hash", hashApiKey(key))
    .eq("is_active", true)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as unknown as ApiKeyRow;
  if (!row.employee_id || !row.employees || row.employees.is_active !== true) return null;
  // 만료일이 지난 키(yb login 키는 90일)는 거부한다.
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then();

  const employee = toRouteEmployee(row.employees);
  return {
    id: row.id,
    name: row.name,
    created_by: employee.name,
    employee_id: employee.id,
    employee,
  };
}

/** 키가 유효한지만 본다. 누가 불렀는지 필요하면 validateApiKeyRecord 를 쓴다. */
export async function validateApiKey(request: Request): Promise<boolean> {
  return (await validateApiKeyRecord(request)) !== null;
}
