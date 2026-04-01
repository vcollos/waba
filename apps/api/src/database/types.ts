export type Role = 'admin' | 'operator' | 'viewer';

export interface IntegrationRecord {
  id: string;
  name: string;
  graphApiVersion: string;
  graphApiBase: string;
  wabaId: string;
  phoneNumberId: string;
  accessTokenCiphertext: string;
  verifyTokenCiphertext: string;
  appSecretCiphertext?: string | null;
  webhookCallbackUrl?: string | null;
  status: 'active' | 'inactive';
  lastSyncAt?: string | null;
  lastHealthcheckAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactRecord {
  id: string;
  externalRef?: string | null;
  clientName?: string | null;
  firstName: string;
  lastName?: string | null;
  name: string;
  category?: string | null;
  recordStatus: 'active' | 'inactive';
  phoneRaw: string;
  phoneE164: string;
  phoneHash: string;
  email?: string | null;
  attributes: Record<string, string>;
  isValid: boolean;
  validationError?: string | null;
  isOptedOut: boolean;
  optedOutAt?: string | null;
  optOutSource?: string | null;
  importedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListRecord {
  id: string;
  name: string;
  description?: string | null;
  sourceType: 'csv' | 'manual' | 'api';
  sourceFilePath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListMemberRecord {
  id: string;
  listId: string;
  contactId: string;
  createdAt: string;
}

export interface ImportRecord {
  id: string;
  listId: string;
  fileName: string;
  fileSha256: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  fieldMapping?: Record<string, string | null>;
  defaults?: Record<string, string | null>;
  status: 'completed' | 'failed';
  createdAt: string;
}

export interface TemplateVariableDescriptor {
  componentType: 'body' | 'header';
  placeholderIndex: number;
  label: string;
}

export interface TemplateCacheRecord {
  id: string;
  integrationId: string;
  metaTemplateId: string;
  name: string;
  languageCode: string;
  category: string;
  status: string;
  components: unknown[];
  hasFlowButton: boolean;
  flowButtonMeta?: Record<string, unknown> | null;
  variableDescriptors: TemplateVariableDescriptor[];
  raw: Record<string, unknown>;
  lastSyncedAt: string;
}

export interface FlowCacheRecord {
  id: string;
  integrationId: string;
  metaFlowId: string;
  name: string;
  categories: string[];
  status: string;
  jsonVersion?: string | null;
  dataApiVersion?: string | null;
  previewUrl?: string | null;
  previewExpiresAt?: string | null;
  healthStatus?: Record<string, unknown> | null;
  endpointUri?: string | null;
  assets?: Record<string, unknown>[] | null;
  completionPayloadDefinitions?: FlowCompletionPayloadDefinition[] | null;
  raw: Record<string, unknown>;
  lastSyncedAt: string;
}

export interface FlowCompletionPayloadField {
  key: string;
  sourceType: 'form' | 'static' | 'expression';
  sourceField?: string | null;
  expression?: string | null;
  staticValue?: string | null;
}

export interface FlowCompletionPayloadDefinition {
  screenId: string;
  formName?: string | null;
  actionName: string;
  payloadFields: FlowCompletionPayloadField[];
}

export type ParameterSource =
  | { type: 'static'; value: string }
  | { type: 'contact_name' }
  | { type: 'contact_phone' }
  | { type: 'contact_email' }
  | { type: 'contact_attribute'; key: string };

export type CampaignAudienceMode = 'all' | 'fixed_count' | 'percentage';
export type CampaignAudienceOrderMode = 'field' | 'random';
export type CampaignAudienceOrderField =
  | 'clientName'
  | 'firstName'
  | 'lastName'
  | 'name'
  | 'category'
  | 'phoneE164'
  | 'importedAt'
  | 'createdAt';
export type CampaignAudienceResendPolicy = 'all' | 'not_delivered' | 'not_read';

export interface CampaignAudienceConfig {
  mode: CampaignAudienceMode;
  fixedCount?: number | null;
  percentage?: number | null;
  orderMode: CampaignAudienceOrderMode;
  orderField?: CampaignAudienceOrderField | null;
  orderDirection: 'asc' | 'desc';
  resendPolicy: CampaignAudienceResendPolicy;
  uniqueWhatsAppOnly?: boolean;
}

export interface CampaignAudienceSnapshot {
  listMembersTotal: number;
  eligibleCount: number;
  afterResendFilterCount: number;
  afterUniqueWhatsAppFilterCount?: number;
  excludedByUniqueWhatsApp?: number;
  excludedByResendPolicy: number;
  selectedCount: number;
}

export interface CampaignRecord {
  id: string;
  integrationId: string;
  name: string;
  mode: 'template' | 'template_flow' | 'session_flow';
  templateCacheId?: string | null;
  flowCacheId?: string | null;
  listId: string;
  parameterMapping: Record<string, ParameterSource>;
  audience: CampaignAudienceConfig;
  audienceSnapshot: CampaignAudienceSnapshot;
  sendRateMps: number;
  status:
    | 'draft'
    | 'queued'
    | 'sending'
    | 'paused'
    | 'completed'
    | 'cancelled'
    | 'failed';
  scheduledAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  summary: {
    total: number;
    pending: number;
    accepted: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    skipped: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CampaignMessageRecord {
  id: string;
  campaignId: string;
  contactId: string;
  phoneE164: string;
  status:
    | 'pending'
    | 'accepted'
    | 'sent'
    | 'delivered'
    | 'read'
    | 'failed'
    | 'skipped'
    | 'cancelled';
  skipReason?: string | null;
  payload: Record<string, unknown>;
  payloadHash: string;
  flowToken?: string | null;
  providerMessageId?: string | null;
  providerConversationId?: string | null;
  providerErrorCode?: string | null;
  providerErrorTitle?: string | null;
  providerErrorMessage?: string | null;
  attemptCount: number;
  nextAttemptAt?: string | null;
  lastAttemptAt?: string | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  failedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageEventRecord {
  id: string;
  campaignMessageId?: string | null;
  providerMessageId?: string | null;
  eventType: string;
  status?: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
  dedupeKey: string;
}

export interface FlowResponseRecord {
  id: string;
  integrationId: string;
  campaignId?: string | null;
  campaignMessageId?: string | null;
  contactId?: string | null;
  templateCacheId?: string | null;
  flowCacheId?: string | null;
  metaFlowId?: string | null;
  flowToken?: string | null;
  providerMessageId: string;
  providerContextMessageId?: string | null;
  waId: string;
  responsePayload: Record<string, unknown>;
  responsePayloadRaw?: string | null;
  rawMessage: Record<string, unknown>;
  rawWebhook: Record<string, unknown>;
  completedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OptOutRecord {
  id: string;
  contactId: string;
  source: 'inbound_keyword' | 'manual' | 'import' | 'api';
  keyword?: string | null;
  notes?: string | null;
  createdAt: string;
}

export interface AuditLogRecord {
  id: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UserSession {
  id: string;
  email: string;
  role: Role;
}

export interface AppState {
  integrations: IntegrationRecord[];
  contacts: ContactRecord[];
  lists: ListRecord[];
  listMembers: ListMemberRecord[];
  imports: ImportRecord[];
  templates: TemplateCacheRecord[];
  flows: FlowCacheRecord[];
  campaigns: CampaignRecord[];
  campaignMessages: CampaignMessageRecord[];
  messageEvents: MessageEventRecord[];
  flowResponses: FlowResponseRecord[];
  optOuts: OptOutRecord[];
  auditLogs: AuditLogRecord[];
}

export const emptyState = (): AppState => ({
  integrations: [],
  contacts: [],
  lists: [],
  listMembers: [],
  imports: [],
  templates: [],
  flows: [],
  campaigns: [],
  campaignMessages: [],
  messageEvents: [],
  flowResponses: [],
  optOuts: [],
  auditLogs: [],
});
