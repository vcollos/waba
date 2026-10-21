import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { AppState, CampaignMessageRecord, CampaignRecord, FlowResponseRecord } from '../database/types';

type DeliveryStatus = CampaignMessageRecord['status'];
type Presence = 'yes' | 'no' | 'unknown';
export interface CampaignResultsQuery {
  limit?: number; offset?: number; search?: string;
  response?: 'all' | 'yes' | 'no'; presence?: 'all' | Presence;
  status?: 'all' | DeliveryStatus;
}
interface Recipient {
  messageId: string; contactId: string; name: string; firstName: string; lastName: string;
  phone: string; email: string | null; category: string | null;
  institutionRepresented: string | null; jobTitle: string | null;
  status: DeliveryStatus; sentAt: string | null; deliveredAt: string | null; readAt: string | null;
  responded: boolean; respondedAt: string | null; presence: Presence; observation: string | null;
  textReplies: Array<{ messageId: string; text: string; receivedAt: string }>;
  answers: Array<{ key: string; label: string; value: string }>;
}
type InternalRecipient = Recipient & { evidence: { accepted: boolean; sent: boolean; delivered: boolean; read: boolean } };
const statuses = ['pending', 'accepted', 'sent', 'delivered', 'read', 'failed', 'skipped', 'cancelled'];
const rank: Partial<Record<DeliveryStatus, number>> = { accepted: 1, sent: 2, delivered: 3, read: 4 };
const text = (value: unknown, max = 200): string => typeof value === 'string' ? value.trim().slice(0, max) : '';
const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const digits = (value: string) => value.replace(/\D/g, '');
const date = (value: unknown): string | null => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function contactProfile(value: unknown) {
  try {
    // LEGACY_COMPAT: contacts.attributes_json pode ser TEXT ou JSONB; remover após uniformizar o schema.
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    const attributes = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {};
    return { institutionRepresented: text(attributes.institutionRepresented) || null, jobTitle: text(attributes.jobTitle) || null };
  } catch {
    return { institutionRepresented: null, jobTitle: null };
  }
}
const ANSWER_KEYS = new Set([
  'presenca', 'confirmapresenca', 'confirmacaopresenca', 'presence', 'attendance',
  'observacao', 'observacoes', 'observation', 'observations',
  'atividade', 'activity', 'evento', 'event',
]);

export function validateCampaignQuery(input: CampaignResultsQuery) {
  const limit = input.limit ?? 25;
  const offset = input.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000 ||
      (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) ||
      !['all', 'yes', 'no'].includes(input.response ?? 'all') ||
      !['all', 'yes', 'no', 'unknown'].includes(input.presence ?? 'all') ||
      !['all', ...statuses].includes(input.status ?? 'all')) throw new BadRequestException('Filtros de campanha inválidos');
  return { ...input, limit, offset };
}

/** Allowlist do contrato de negócio; novos campos exigem extensão deliberada. */
export function sanitizeCampaignAnswers(payload: Record<string, unknown>) {
  const answers: Recipient['answers'] = [];
  for (const [key, raw] of Object.entries(payload).slice(0, 100)) {
    const normalizedKey = normalized(key).replace(/[^a-z0-9]/g, '');
    if (!key || key.length > 100 || !ANSWER_KEYS.has(normalizedKey)) continue;
    let value: string;
    if (typeof raw === 'string') value = raw.trim().slice(0, 2000);
    else if (typeof raw === 'number' && Number.isFinite(raw)) value = String(raw);
    else if (typeof raw === 'boolean') value = raw ? 'Sim' : 'Não';
    else if (Array.isArray(raw) && raw.length <= 20 && raw.every((item) => typeof item === 'string')) value = raw.map((item) => item.slice(0, 100)).join(', ');
    else continue;
    if (value) answers.push({ key, label: key.replace(/[_-]+/g, ' '), value });
  }
  return answers;
}

function answerPresence(answers: Recipient['answers']): Presence {
  const answer = answers.find(({ key }) => ['presenca', 'confirmapresenca', 'confirmacaopresenca', 'presence', 'attendance'].includes(normalized(key).replace(/[^a-z]/g, '')));
  if (!answer) return 'unknown';
  const value = normalized(answer.value).replace(/^\d+[_ -]+/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (['sim', 'yes', 'true', 'confirmo', 'confirmado', 'vou'].includes(value)) return 'yes';
  if (['nao', 'no', 'false', 'nao vou', 'nao comparecerei'].includes(value)) return 'no';
  return 'unknown';
}

function evidenceStatus(message: CampaignMessageRecord): DeliveryStatus {
  if (date(message.readAt) || message.status === 'read') return 'read';
  if (date(message.deliveredAt) || message.status === 'delivered') return 'delivered';
  if (message.status === 'failed') return 'failed';
  if (date(message.sentAt) || message.status === 'sent') return 'sent';
  return message.status;
}

export function campaignIdentity(campaign: CampaignRecord, state: Readonly<AppState>) {
  const template = state.templates.find((item) => item.id === campaign.templateCacheId && item.integrationId === campaign.integrationId);
  const flow = state.flows.find((item) => item.id === campaign.flowCacheId && item.integrationId === campaign.integrationId);
  const templateId = text(campaign.metaTemplateId) || text(template?.metaTemplateId) || null;
  const flowId = text(campaign.metaFlowId) || text(flow?.metaFlowId) ||
    (template?.hasFlowButton ? text(template.flowButtonMeta?.flow_id) : '') || null;
  const namedTemplate = templateId && (template?.metaTemplateId === templateId ? template :
    state.templates.find((item) => item.integrationId === campaign.integrationId && item.metaTemplateId === templateId));
  const namedFlow = flowId && (flow?.metaFlowId === flowId ? flow :
    state.flows.find((item) => item.integrationId === campaign.integrationId && item.metaFlowId === flowId));
  return {
    integrationId: campaign.integrationId,
    templateId,
    templateName: namedTemplate ? text(namedTemplate.name) || null : null,
    flowId,
    flowName: namedFlow ? text(namedFlow.name) || null : null,
    flowIdentityStatus: flowId ? 'resolved' :
      campaign.mode === 'template' && !campaign.flowCacheId && template?.hasFlowButton !== true ? 'none' : 'unresolved',
  };
}

function summarize(campaign: CampaignRecord, rows: InternalRecipient[], state: Readonly<AppState>) {
  const count = (predicate: (row: InternalRecipient) => boolean) => rows.filter(predicate).length;
  const responded = count((row) => row.responded);
  return {
    id: campaign.id, name: text(campaign.name), status: campaign.status, createdAt: campaign.createdAt,
    ...campaignIdentity(campaign, state),
    startedAt: date(campaign.startedAt), finishedAt: date(campaign.finishedAt),
    counters: {
      total: rows.length, accepted: count((row) => row.evidence.accepted),
      sent: count((row) => row.evidence.sent), delivered: count((row) => row.evidence.delivered),
      read: count((row) => row.evidence.read), failed: count((row) => row.status === 'failed'),
      responded, notResponded: rows.length - responded,
      presenceYes: count((row) => row.presence === 'yes'), presenceNo: count((row) => row.presence === 'no'),
    },
  };
}

@Injectable()
export class PublicCampaignsService {
  constructor(private readonly database: DatabaseService) {}

  private async campaignsForList(listId: string, clientId: string) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(listId) || !clientId) throw new BadRequestException('Lista inválida');
    const [list] = await this.database.postgresQuery<{ id: string; name: string }>(
      'SELECT id, name FROM lists WHERE id = $1 AND client_id = $2', [listId, clientId],
    );
    if (!list) throw new NotFoundException('Lista não encontrada');
    const state = await this.database.readMetaSnapshot();
    // A integração é compartilhada N:N; seu client_id nunca autoriza campanha.
    const campaigns = state.campaigns.filter((campaign) => campaign.clientId === clientId && campaign.listId === listId);
    return { list, campaigns, state };
  }

  async list(listId: string, clientId: string) {
    const { list, campaigns, state } = await this.campaignsForList(listId, clientId);
    const items = [];
    for (const campaign of campaigns.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))) {
      items.push(summarize(campaign, await this.recipients(campaign, clientId, state), state));
    }
    return { listId: list.id, listName: text(list.name), campaigns: items };
  }

  async results(listId: string, campaignId: string, clientId: string, input: CampaignResultsQuery = {}) {
    const query = validateCampaignQuery(input);
    const { campaigns, state } = await this.campaignsForList(listId, clientId);
    const campaign = campaigns.find((item) => item.id === campaignId);
    if (!campaign) throw new NotFoundException('Campanha não encontrada nesta lista');
    // Autorização completa ocorre ANTES de carregar mensagens, mesmo sem respostas.
    const rows = await this.recipients(campaign, clientId, state);
    const search = normalized(query.search?.trim() ?? '');
    const filtered = rows.filter((row) => {
      if (query.response && query.response !== 'all' && row.responded !== (query.response === 'yes')) return false;
      if (query.presence && query.presence !== 'all' && row.presence !== query.presence) return false;
      if (query.status && query.status !== 'all') {
        if (rank[query.status] ? !row.evidence[query.status as keyof InternalRecipient['evidence']] : row.status !== query.status) return false;
      }
      return !search || normalized([row.name, row.phone, row.email, row.institutionRepresented, row.jobTitle, row.category].join(' ')).includes(search);
    });
    return { listId, campaign: summarize(campaign, rows, state), total: filtered.length, limit: query.limit, offset: query.offset,
      items: filtered.slice(query.offset, query.offset + query.limit).map(({ evidence: _evidence, ...row }) => row) };
  }

  private async recipients(campaign: CampaignRecord, clientId: string, state: Readonly<AppState>): Promise<InternalRecipient[]> {
    const [messages, responses] = await Promise.all([
      this.database.listCampaignMessagesInDatabase({ campaignId: campaign.id }),
      this.database.listFlowResponsesInDatabase({ campaignId: campaign.id }),
    ]);
    // N:N: campaign_message_id do webhook é heurístico; só contexto Meta explícito
    // + remetente + número receptor, ou classificação manual auditada, autorizam exposição.
    const phoneNumberId = state.integrations?.find((item) => item.id === campaign.integrationId)?.phoneNumberId;
    const textReplies = phoneNumberId && messages.length
      ? await this.database.postgresQuery<{ campaign_message_id: string; message_id: string; body: string; received_at: string }>(
        `SELECT DISTINCT cm.id AS campaign_message_id, me.provider_message_id AS message_id,
                inbound->'text'->>'body' AS body, me.received_at::text AS received_at
         FROM message_events me
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(me.record_json->'payload'->'entry') = 'array'
           THEN me.record_json->'payload'->'entry' ELSE '[]'::jsonb END) entry
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(entry->'changes') = 'array'
           THEN entry->'changes' ELSE '[]'::jsonb END) change
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(change->'value'->'messages') = 'array'
           THEN change->'value'->'messages' ELSE '[]'::jsonb END) inbound
         JOIN campaign_messages cm ON (cm.provider_message_id = inbound->'context'->>'id'
           OR (inbound->'context'->>'id' IS NULL AND cm.id = me.record_json->'manualCampaignAssociation'->>'campaignMessageId'))
         WHERE me.event_type = 'meta.inbound' AND cm.campaign_id = $1
           AND change->'value'->'metadata'->>'phone_number_id' = $2
           AND inbound->>'id' = me.provider_message_id AND me.provider_message_id <> ''
           AND inbound->>'type' = 'text' AND jsonb_typeof(inbound->'text'->'body') = 'string'
           AND length(inbound->'text'->>'body') BETWEEN 1 AND 4096
           AND inbound->>'from' ~ '^[0-9]{7,15}$'
           AND inbound->>'from' = regexp_replace(cm.record_json->>'phoneE164', '[^0-9]', '', 'g')
           AND cm.provider_message_id <> ''
           AND (
             (cm.provider_message_id = inbound->'context'->>'id'
               AND (SELECT count(*) FROM campaign_messages duplicate
                    WHERE duplicate.provider_message_id = cm.provider_message_id) = 1)
             OR (inbound->'context'->>'id' IS NULL
               AND me.record_json->'manualCampaignAssociation'->>'clientId' = $3
               AND me.record_json->'manualCampaignAssociation'->>'listId' = $4
               AND me.record_json->'manualCampaignAssociation'->>'campaignId' = $1
               AND me.record_json->'manualCampaignAssociation'->>'integrationId' = $5
               AND me.record_json->'manualCampaignAssociation'->>'phoneNumberId' = $2
               AND EXISTS (SELECT 1 FROM audit_logs audit
                 WHERE audit.id = me.record_json->'manualCampaignAssociation'->>'auditLogId'
                   AND audit.record_json->>'action' = 'campaign.text_reply.linked'
                   AND audit.record_json->>'entityType' = 'message_event'
                   AND audit.record_json->>'entityId' = me.provider_message_id
                   AND audit.record_json->>'actorUserId' <> ''
                   AND audit.record_json->'metadata'->'association' = me.record_json->'manualCampaignAssociation'))
           )
         ORDER BY received_at, message_id`, [campaign.id, phoneNumberId, clientId, campaign.listId, campaign.integrationId]) : [];
    const repliesByMessage = new Map<string, Recipient['textReplies']>();
    for (const reply of textReplies) {
      const receivedAt = date(reply.received_at);
      if (!receivedAt || !reply.message_id || typeof reply.body !== 'string' || !reply.body.trim() || reply.body.length > 4096) continue;
      const replies = repliesByMessage.get(reply.campaign_message_id) ?? [];
      if (!replies.some((item) => item.messageId === reply.message_id)) {
        replies.push({ messageId: reply.message_id, text: reply.body, receivedAt });
      }
      repliesByMessage.set(reply.campaign_message_id, replies);
    }
    if ([...repliesByMessage.values()].some((replies) => replies.length > 100)) {
      throw new ServiceUnavailableException('Mais de 100 respostas textuais para um destinatário; consulta requer paginação de respostas');
    }
    const ids = [...new Set(messages.map((message) => message.contactId).filter(Boolean))];
    const contacts = ids.length ? await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, first_name, last_name, name, phone_e164, email, category, attributes_json
       FROM contacts WHERE id = ANY($1::text[]) AND client_id = $2`, [ids, clientId],
    ) : [];
    const byContact = new Map(contacts.map((contact) => [String(contact.id), contact]));
    const relevant = responses.filter((response) => response.campaignId === campaign.id && response.integrationId === campaign.integrationId)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id.localeCompare(a.id));
    const byMessage = new Map<string, FlowResponseRecord>();
    const unlinkedContact = new Map<string, FlowResponseRecord>();
    const unlinkedPhone = new Map<string, FlowResponseRecord>();
    for (const response of relevant) {
      if (response.campaignMessageId) {
        if (!byMessage.has(response.campaignMessageId)) byMessage.set(response.campaignMessageId, response);
      } else {
        if (response.contactId && !unlinkedContact.has(response.contactId)) unlinkedContact.set(response.contactId, response);
        const phone = digits(response.waId);
        if (!response.contactId && phone && !unlinkedPhone.has(phone)) unlinkedPhone.set(phone, response);
      }
    }
    const latestMessageByContact = new Map<string, string>();
    const latestMessageByPhone = new Map<string, string>();
    for (const message of [...messages].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))) {
      if (!latestMessageByContact.has(message.contactId)) latestMessageByContact.set(message.contactId, message.id);
      const phone = digits(message.phoneE164);
      if (phone && !latestMessageByPhone.has(phone)) latestMessageByPhone.set(phone, message.id);
    }
    return [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((message) => {
      const contact = byContact.get(message.contactId);
      // Telefone snapshot do envio continua válido se o contato sair da lista/mudar depois.
      const phone = text(message.phoneE164 || contact?.phone_e164);
      const response = byMessage.get(message.id) ??
        (latestMessageByContact.get(message.contactId) === message.id ? unlinkedContact.get(message.contactId) : undefined) ??
        (latestMessageByPhone.get(digits(phone)) === message.id ? unlinkedPhone.get(digits(phone)) : undefined);
      const answers = response ? sanitizeCampaignAnswers(response.responsePayload) : [];
      const replies = repliesByMessage.get(message.id) ?? [];
      const respondedAt = [date(response?.completedAt), ...replies.map((reply) => reply.receivedAt)]
        .filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
      const status = evidenceStatus(message);
      const read = status === 'read';
      const delivered = read || status === 'delivered';
      const sent = delivered || Boolean(date(message.sentAt)) || status === 'sent';
      return {
        messageId: message.id, contactId: message.contactId, name: text(contact?.name),
        firstName: text(contact?.first_name), lastName: text(contact?.last_name), phone,
        email: text(contact?.email) || null, category: text(contact?.category) || null,
        ...contactProfile(contact?.attributes_json),
        status, sentAt: date(message.sentAt), deliveredAt: date(message.deliveredAt), readAt: date(message.readAt),
        evidence: { accepted: sent || Boolean(message.providerMessageId) || status === 'accepted', sent, delivered, read },
        responded: Boolean(response) || replies.length > 0, respondedAt, presence: answerPresence(answers),
        observation: answers.find(({ key }) => ['observacao', 'observacoes', 'observation'].includes(normalized(key).replace(/[^a-z]/g, '')))?.value ?? null,
        answers, textReplies: replies,
      };
    });
  }
}
