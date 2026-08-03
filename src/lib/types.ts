export type EmployeeType = "관리자" | "직원";

export interface Employee {
  id: string;
  name: string;
  department: string | null;
  position: string | null;
  employee_type?: EmployeeType | null;
  is_finance?: boolean | null;
  is_active?: boolean | null;
  failed_login_count?: number | null;
  failed_login_window_started_at?: string | null;
  last_failed_login_at?: string | null;
  last_login_at?: string | null;
  email: string | null;
  phone: string | null;
  slack_id: string | null;
  hire_date: string | null;
  login_id: string | null;
  auth_uid: string | null;
  focused_task_id?: string | null;
  created_at: string;
  updated_at: string;
}

export type EmployeeInsert = Omit<Employee, "id" | "auth_uid" | "created_at" | "updated_at">;
export type EmployeeUpdate = Partial<EmployeeInsert>;

export type CustomerType = "개인" | "개인사업자" | "법인";

export type VendorTaxCategory =
  | "personal_withholding"
  | "business_vat"
  | "corporate_vat"
  | "none";

export interface Customer {
  id: string;
  customer_type: CustomerType | null;
  name: string;
  representative_name: string | null;
  business_number: string | null;
  resident_number: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  memo: string | null;
  tax_category: VendorTaxCategory | null;
  default_withholding_rate: number | null;
  bank_name: string | null;
  account_number: string | null;
  account_holder: string | null;
  drive_folder_id: string | null;
  is_vendor: boolean;
  created_at: string;
  updated_at: string;
}

export type CustomerInsert = Omit<
  Customer,
  "id" | "created_at" | "updated_at" | "is_vendor" | "drive_folder_id"
>;
export type CustomerUpdate = Partial<CustomerInsert>;

export interface CustomerContact {
  id: string;
  customer_id: string;
  name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
}

export type CustomerContactInsert = Omit<CustomerContact, "id" | "created_at" | "updated_at">;

export interface ProjectType {
  id: string;
  name: string;
  sort_order: number;
  drive_folder_id: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  project_number: string;
  name: string;
  customer_id: string | null;
  type_id: string | null;
  client: string | null;
  description: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  manager: string | null;
  drive_folder_id: string | null;
  created_at: string;
  updated_at: string;
  assignees?: ProjectAssignee[];
  customers?: {
    id: string;
    name: string;
    business_number: string | null;
    drive_folder_id: string | null;
  } | null;
  project_types?: {
    id: string;
    name: string;
  } | null;
}

export interface ProjectNote {
  id: string;
  project_id: string;
  title: string | null;
  content: string | null;
  link_url: string | null;
  author_employee_id: string | null;
  author_name: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectAssignee {
  id: string;
  project_id: string;
  employee_id: string;
  created_at: string;
  employees?:
    | { id: string; name: string; department: string | null }
    | { id: string; name: string; department: string | null }[]
    | null;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  webContentLink?: string;
  iconLink?: string;
  thumbnailLink?: string;
}

export type ProjectInsert = Omit<
  Project,
  "id" | "project_number" | "drive_folder_id" | "created_at" | "updated_at" | "assignees" | "customers" | "project_types"
>;

export type ProjectNoteInsert = Omit<ProjectNote, "id" | "created_at" | "updated_at">;
export type ProjectNoteUpdate = Partial<Omit<ProjectNoteInsert, "project_id" | "author_employee_id" | "author_name">>;

export interface CustomerNote {
  id: string;
  customer_id: string;
  title: string | null;
  content: string | null;
  link_url: string | null;
  author_employee_id: string | null;
  author_name: string;
  created_at: string;
  updated_at: string;
}

export type CustomerNoteInsert = Omit<CustomerNote, "id" | "created_at" | "updated_at">;
export type CustomerNoteUpdate = Partial<
  Omit<CustomerNoteInsert, "customer_id" | "author_employee_id" | "author_name">
>;

export type RevenueChannel = "아임웹" | "자사몰" | "기타";

export interface Revenue {
  id: string;
  project_id: string | null;
  type_id: string | null;
  channel: RevenueChannel | null;
  product_name: string | null;
  external_order_id: string | null;
  title: string;
  total_amount: number;
  supply_amount: number;
  vat_amount: number;
  revenue_date: string | null;
  is_paid: boolean;
  paid_date: string | null;
  vat_included: boolean;
  is_tax_invoice_issued: boolean;
  tax_invoice_not_required: boolean;
  tax_invoice_date: string | null;
  tax_invoice_issue_status: "not_issued" | "issuing" | "issued" | "failed";
  tax_invoice_issuance_key: string | null;
  tax_invoice_client_reference_id: string | null;
  tax_invoice_issue_requested_at: string | null;
  tax_invoice_issued_at: string | null;
  tax_invoice_last_webhook_at: string | null;
  tax_invoice_url: string | null;
  tax_invoice_nts_transaction_id: string | null;
  tax_invoice_error_code: string | null;
  tax_invoice_error_message: string | null;
  tax_invoice_request_payload: Record<string, unknown> | null;
  tax_invoice_last_payload: Record<string, unknown> | null;
  expected_payment_date: string | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
  project_types?: { id: string; name: string } | null;
  projects?: {
    id: string;
    project_number: string;
    name: string;
    project_types?: { id: string; name: string } | null;
  } | null;
}

export type RevenueInsert = Omit<
  Revenue,
  | "id"
  | "created_at"
  | "updated_at"
  | "project_types"
  | "projects"
  | "tax_invoice_issue_status"
  | "tax_invoice_issuance_key"
  | "tax_invoice_client_reference_id"
  | "tax_invoice_issue_requested_at"
  | "tax_invoice_issued_at"
  | "tax_invoice_last_webhook_at"
  | "tax_invoice_url"
  | "tax_invoice_nts_transaction_id"
  | "tax_invoice_error_code"
  | "tax_invoice_error_message"
  | "tax_invoice_request_payload"
  | "tax_invoice_last_payload"
>;

export interface ExpenseType {
  id: string;
  name: string;
  sort_order: number;
  account_code: string | null;
  is_vat_deductible: boolean;
  created_at: string;
}

export type ExpenseTypeInsert = Omit<ExpenseType, "id" | "created_at">;

export type ExpenseStatus =
  | "draft"
  | "requested"
  | "approved"
  | "rejected"
  | "scheduled"
  | "paid"
  | "cancelled";

export const EXPENSE_STATUS_LABEL: Record<ExpenseStatus, string> = {
  draft: "초안",
  requested: "결의중",
  approved: "승인",
  rejected: "반려",
  scheduled: "지급예정",
  paid: "지급완료",
  cancelled: "취소",
};

export interface Expense {
  id: string;
  project_id: string | null;
  type_id: string | null;
  title: string;
  vendor_name: string | null;
  vendor_id: string | null;
  total_amount: number;
  supply_amount: number;
  vat_amount: number;
  vat_included: boolean;
  purchase_date: string | null;
  payment_date: string | null;
  purchase_tax_invoice_received: boolean;
  purchase_tax_invoice_date: string | null;
  purchase_tax_invoice_not_required: boolean;
  status: ExpenseStatus;
  tax_category: VendorTaxCategory | null;
  withholding_rate: number | null;
  withholding_amount: number;
  net_payment_amount: number;
  requested_by: string | null;
  requested_at: string | null;
  approver_id: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  slack_thread_ts: string | null;
  memo: string | null;
  source: ExpenseSource;
  recurring_expense_id: string | null;
  receipt_url: string | null;
  created_at: string;
  updated_at: string;
  expense_types?: { id: string; name: string } | null;
  projects?: {
    id: string;
    project_number: string;
    name: string;
  } | null;
  vendor?: {
    id: string;
    name: string;
    customer_type?: CustomerType;
    tax_category: VendorTaxCategory | null;
    contact_phone: string | null;
    bank_name: string | null;
    account_number: string | null;
    account_holder: string | null;
  } | null;
}

export type ExpenseInsert = Omit<
  Expense,
  | "id"
  | "created_at"
  | "updated_at"
  | "expense_types"
  | "projects"
  | "vendor"
  | "net_payment_amount"
  | "status"
  | "requested_by"
  | "requested_at"
  | "approver_id"
  | "approved_at"
  | "rejected_reason"
  | "cancelled_at"
  | "cancelled_reason"
  | "slack_thread_ts"
  | "source"
  | "recurring_expense_id"
  | "receipt_url"
>;

export interface RecurringExpense {
  id: string;
  title: string;
  type_id: string | null;
  vendor_name: string | null;
  vendor_id: string | null;
  amount: number;
  vat_included: boolean;
  day_of_month: number;
  start_date: string;
  end_date: string | null;
  last_generated_month: string | null;
  is_active: boolean;
  memo: string | null;
  created_at: string;
  updated_at: string;
  expense_types?: { id: string; name: string } | null;
  vendor?: { id: string; name: string } | null;
}

export type RecurringExpenseInsert = Omit<
  RecurringExpense,
  "id" | "created_at" | "updated_at" | "last_generated_month" | "expense_types" | "vendor"
>;
export type RecurringExpenseUpdate = Partial<RecurringExpenseInsert>;

export type ExpenseSource = "manual" | "recurring";

export interface ExpenseStatusHistory {
  id: string;
  expense_id: string;
  from_status: ExpenseStatus | null;
  to_status: ExpenseStatus;
  actor_id: string | null;
  actor_name: string | null;
  reason: string | null;
  created_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  can_reveal: boolean;
  created_by: string;
  last_used_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type RecurrenceType = 'none' | 'daily' | 'weekly' | 'monthly';
export type ScheduleRecurrenceActionScope = 'single' | 'following' | 'all';

export interface Schedule {
  id: string;
  title: string;
  description: string | null;
  start_at: string;
  end_at: string;
  all_day: boolean;
  category: string;
  location: string | null;
  google_meet_link: string | null;
  project_id: string | null;
  customer_id: string | null;
  lead_id: string | null;
  recurrence_type: RecurrenceType;
  recurrence_end_date: string | null;
  recurrence_group_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  creator?: { id: string; name: string } | null;
  projects?: {
    id: string;
    project_number: string;
    name: string;
  } | null;
  customers?: { id: string; name: string } | null;
  leads?: { id: string; company_name: string } | null;
  attendees?: ScheduleAttendee[];
}

export type ScheduleInsert = Omit<
  Schedule,
  "id" | "created_at" | "updated_at" | "creator" | "projects" | "customers" | "leads" | "attendees" | "google_meet_link"
>;

export interface ScheduleAttendee {
  id: string;
  schedule_id: string;
  employee_id: string;
  created_at: string;
  employees?: { id: string; name: string; department: string | null } | null;
}

export interface ScheduleCategoryItem {
  id: string;
  value: string;
  label: string;
  color: string;
  sort_order: number;
  created_at: string;
}

export type TaskStatus = '백로그' | '할 일' | '진행중' | '완료' | '취소';
export type TaskPriority = '높음' | '보통' | '낮음';

export interface TaskAssignee {
  id: string;
  task_id: string;
  employee_id: string;
  created_at: string;
  employees?:
    | { id: string; name: string; department: string | null }
    | { id: string; name: string; department: string | null }[]
    | null;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  start_date: string | null;
  due_date: string | null;
  project_id: string | null;
  sort_order: number;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  slack_thread_ts?: string | null;
  created_at: string;
  updated_at: string;
  projects?: {
    id: string;
    project_number: string;
    name: string;
  } | null;
  assignees?: TaskAssignee[];
}

export type TaskInsert = Omit<Task, 'id' | 'created_at' | 'updated_at' | 'projects' | 'assignees'> & {
  assignee_ids?: string[];
};

export type LeadType = '개발' | '교육';
export type LeadStatus = '신규' | '상담중' | '견적발송' | '계약완료' | '실패' | '보류';
export type LeadSource = '폼문의' | '전화' | '이메일' | '소개' | '기타';
export type EduDeliveryMode = '온라인' | '오프라인' | '혼합';

export interface Lead {
  id: string;
  lead_type: LeadType;
  company_name: string;
  contact_name: string;
  phone: string;
  email: string | null;
  position: string | null;
  referral_source: string | null;
  industry: string | null;
  automation_areas: string[] | null;
  budget: string | null;
  desired_timeline: string | null;
  inquiry_detail: string | null;
  edu_schedule: string | null;
  edu_filming_schedule: string | null;
  edu_delivery_mode: EduDeliveryMode | null;
  edu_hourly_rate: number | null;
  edu_estimated_hours: number | null;
  edu_estimated_total: number | null;
  status: LeadStatus;
  source: LeadSource;
  assigned_to: string | null;
  customer_id: string | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
  employees?: { id: string; name: string } | null;
  customers?: { id: string; name: string } | null;
}

export type LeadInsert = Omit<Lead, 'id' | 'created_at' | 'updated_at' | 'employees' | 'customers'>;

export interface Meeting {
  id: string;
  title: string;
  project_id: string | null;
  customer_id: string | null;
  lead_id: string | null;
  transcript: string;
  summary: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  drive_file_id: string | null;
  created_at: string;
  updated_at: string;
  // join 시 사용
  projects?: { project_number: string; name: string } | null;
  customers?: { id: string; name: string } | null;
  leads?: { id: string; company_name: string } | null;
}

// Quotation
export type QuotationStatus = '작성중' | '발송완료' | '수락' | '거절' | '만료';

export interface Quotation {
  id: string;
  quotation_number: string;
  quotation_date: string;
  valid_until: string | null;
  status: QuotationStatus;
  customer_id: string | null;
  recipient_name: string;
  recipient_contact_name: string | null;
  recipient_phone: string | null;
  recipient_address: string | null;
  supplier_name: string;
  supplier_representative: string;
  supplier_business_number: string;
  supplier_phone: string;
  supplier_manager: string;
  supplier_address: string | null;
  supplier_business_type: string | null;
  supplier_business_category: string | null;
  supply_total: number;
  vat_total: number;
  grand_total: number;
  payment_terms: string | null;
  delivery_terms: string | null;
  bank_account: string;
  memo: string | null;
  project_id: string | null;
  version: number;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  customers?: { id: string; name: string } | null;
  projects?: { id: string; project_number: string; name: string } | null;
  quotation_items?: QuotationItem[];
}

export type QuotationInsert = Omit<Quotation, 'id' | 'quotation_number' | 'version' | 'created_at' | 'updated_at' | 'customers' | 'projects' | 'quotation_items'>;

export interface QuotationItem {
  id: string;
  quotation_id: string;
  sort_order: number;
  item_name: string;
  specification: string | null;
  unit: string;
  quantity: number;
  unit_price: number;
  supply_amount: number;
  remark: string | null;
  created_at: string;
  updated_at: string;
}

export type QuotationItemInsert = Omit<QuotationItem, 'id' | 'created_at' | 'updated_at'>;

export type LogLevel = "INFO" | "ERROR";

export interface AppLog {
  id: string;
  level: LogLevel;
  action: string;
  resource: string | null;
  resource_id: string | null;
  message: string;
  actor_id: string | null;
  actor_name: string | null;
  ip_address: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

// Deposit
export type DepositSource = "webhook" | "manual";

export interface Deposit {
  id: string;
  deposit_date: string;
  amount: number;
  depositor_name: string;
  bank_name: string | null;
  account_alias: string | null;
  revenue_id: string | null;
  source: DepositSource;
  raw_message: string | null;
  memo: string | null;
  created_at: string;
  updated_at: string;
  revenues?: { id: string; title: string; total_amount: number; projects?: { name: string; client: string | null } | null } | null;
}

export type DepositInsert = Omit<Deposit, "id" | "created_at" | "updated_at" | "revenues">;

export interface Note {
  id: string;
  title: string | null;
  content: string | null;
  link_url: string | null;
  project_id: string | null;
  customer_id: string | null;
  author_employee_id: string | null;
  author_name: string;
  created_at: string;
  updated_at: string;
  projects?: { id: string; project_number: string; name: string } | null;
  customers?: { id: string; name: string } | null;
}

export type NoteInsert = Omit<Note, "id" | "created_at" | "updated_at" | "projects" | "customers">;
export type NoteUpdate = Partial<Omit<NoteInsert, "author_employee_id" | "author_name">>;
