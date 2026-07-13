export type Role = 'super_admin' | 'admin' | 'client_admin' | 'operator' | 'viewer';

/** Papéis da operação Collos (visão "todos os clientes" + telas administrativas). */
export const COLLOS_ROLES: Role[] = ['super_admin', 'admin'];
/** Papéis vinculados a um tenant (Uniodonto). Exigem clientId. */
export const CLIENT_ROLES: Role[] = ['client_admin', 'operator', 'viewer'];

export const isCollosRole = (role: Role): boolean => COLLOS_ROLES.includes(role);

export type EntityStatus = 'active' | 'inactive';

/** Tenant (Uniodonto) operado pela Collos. */
export interface ClientRecord {
  id: string;
  name: string;
  legalName?: string | null;
  cnpj?: string | null;
  billingEmail?: string | null;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Usuário da plataforma. Papéis de cliente têm 1+ tenants em `clientIds`
 * (operam um por vez, via seletor). Papéis Collos têm `clientIds` vazio (veem tudo).
 */
export interface UserRecord {
  id: string;
  clientIds: string[];
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  status: EntityStatus;
  lastLoginAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

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
  /** Tenant proprietário da integração. Nulo = pool Collos compartilhado. */
  clientId?: string | null;
  lastSyncAt?: string | null;
  lastHealthcheckAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactRecord {
  id: string;
  externalRef?: string | null;
  /** Tenant proprietário do contato. Nulo = não atribuído (visível só à Collos). */
  clientId?: string | null;
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
  /** Tenant proprietário da lista. Nulo = não atribuído (visível só à Collos). */
  clientId?: string | null;
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
  /** Nome da variável em templates de formato NAMED (ex.: "link"); null p/ POSITIONAL. */
  paramName?: string | null;
  /** Valor de exemplo aprovado na Meta (usado como sugestão/pré-preenchimento). */
  example?: string | null;
  label: string;
}

/** Header de mídia (IMAGE/VIDEO/DOCUMENT) que exige uma URL no envio. */
export interface TemplateMediaHeader {
  format: 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  /** URL de exemplo (header_handle) aprovada na Meta. */
  example?: string | null;
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
  category?: string | null;
  orderMode: CampaignAudienceOrderMode;
  orderField?: CampaignAudienceOrderField | null;
  orderDirection: 'asc' | 'desc';
  resendPolicy: CampaignAudienceResendPolicy;
  uniqueWhatsAppOnly?: boolean;
}

export interface CampaignAudienceSnapshot {
  listMembersTotal: number;
  eligibleCount: number;
  afterCategoryFilterCount?: number;
  afterResendFilterCount: number;
  afterUniqueWhatsAppFilterCount?: number;
  excludedByCategory?: number;
  excludedByUniqueWhatsApp?: number;
  excludedByResendPolicy: number;
  selectedCount: number;
}

export interface CampaignRecord {
  id: string;
  /** Tenant proprietário da campanha. Nulo = campanha Collos sem tenant. */
  clientId?: string | null;
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
  name: string;
  role: Role;
  /** Tenants que o usuário pode acessar. Vazio = Collos (todos). */
  clientIds: string[];
}

export interface AppState {
  clients: ClientRecord[];
  users: UserRecord[];
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
  clients: [],
  users: [],
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
