import { Injectable, NotFoundException } from '@nestjs/common';
import { campaignIdentity } from '../api-tokens/public-campaigns.service';
import { buildCsv } from '../common/csv';
import { DatabaseService } from '../database/database.service';
import type { CampaignRecord } from '../database/types';

interface MessageRow {
  id: string; campaign_id: string; contact_id: string; phone: string;
  sent: boolean; delivered: boolean; failed: boolean;
}
interface ResponseRow {
  campaign_id: string; campaign_message_id: string | null; contact_id: string | null;
  phone: string; completed_at: string;
}

/** Consolida pessoas pelo telefone histórico do envio, sem alterar a coleta. */
@Injectable()
export class SurveyReportsService {
  constructor(private readonly database: DatabaseService) {}

  private async groups(scope: string | null) {
    const state = await this.database.readMetaSnapshot();
    const groups = new Map<string, {
      id: string; name: string; clientName: string; flowName: string | null;
      flowId: string; integrationId: string; clientId: string | null;
      campaigns: CampaignRecord[]; latestAt: string;
    }>();
    for (const campaign of [...state.campaigns].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
      if (campaign.id.startsWith('svc:') || (scope !== null && campaign.clientId !== scope)) continue;
      const identity = campaignIdentity(campaign, state);
      if (!identity.flowId || identity.flowIdentityStatus !== 'resolved') continue;
      const key = JSON.stringify([campaign.clientId ?? null, campaign.integrationId, identity.flowId]);
      const group = groups.get(key) ?? {
        id: campaign.id, name: campaign.name, clientId: campaign.clientId ?? null,
        clientName: state.clients.find((client) => client.id === campaign.clientId)?.name ?? 'Sem cliente',
        flowId: identity.flowId, flowName: identity.flowName, integrationId: campaign.integrationId,
        campaigns: [], latestAt: campaign.createdAt,
      };
      group.campaigns.push(campaign);
      if (campaign.createdAt > group.latestAt) group.latestAt = campaign.createdAt;
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => b.latestAt.localeCompare(a.latestAt));
  }

  async list(scope: string | null) {
    return (await this.groups(scope)).map(({ campaigns, ...group }) => ({ ...group, executions: campaigns.length }));
  }

  async report(campaignId: string, scope: string | null) {
    const group = (await this.groups(scope)).find((item) => item.campaigns.some((campaign) => campaign.id === campaignId));
    if (!group) throw new NotFoundException('Pesquisa não encontrada');
    const ids = group.campaigns.map((campaign) => campaign.id);
    // Somente colunas necessárias e campanhas já autorizadas. Sem carregar payloads de respostas.
    const [messages, responses] = await Promise.all([
      this.database.postgresQuery<MessageRow>(
        `SELECT id, campaign_id, contact_id,
          regexp_replace(COALESCE(record_json->>'phoneE164', ''), '[^0-9]', '', 'g') AS phone,
          (status IN ('sent', 'delivered', 'read') OR NULLIF(record_json->>'sentAt', '') IS NOT NULL
            OR NULLIF(record_json->>'deliveredAt', '') IS NOT NULL OR NULLIF(record_json->>'readAt', '') IS NOT NULL) AS sent,
          (status IN ('delivered', 'read') OR NULLIF(record_json->>'deliveredAt', '') IS NOT NULL
            OR NULLIF(record_json->>'readAt', '') IS NOT NULL) AS delivered,
          (status = 'failed') AS failed
         FROM campaign_messages WHERE campaign_id = ANY($1::text[])`, [ids]),
      this.database.postgresQuery<ResponseRow>(
        `SELECT campaign_id, campaign_message_id, contact_id,
          regexp_replace(COALESCE(record_json->>'waId', ''), '[^0-9]', '', 'g') AS phone, completed_at::text
         FROM flow_responses WHERE campaign_id = ANY($1::text[]) AND integration_id = $2`,
        [ids, group.integrationId]),
    ]);
    const counts = consolidateSurvey(group.campaigns, messages, responses);
    const { campaigns: _campaigns, ...survey } = group;
    return { survey, ...counts, generatedAt: new Date().toISOString() };
  }

  async csv(campaignId: string, scope: string | null) {
    const report = await this.report(campaignId, scope);
    const row = (name: string, totals: typeof report.totals) => [name, totals.audience, totals.contacted,
      totals.delivered, totals.responded, totals.unanswered, totals.responseRate, totals.messages, totals.failedMessages];
    return '\uFEFF' + buildCsv(
      ['Pesquisa / envio', 'Pessoas no público', 'Pessoas com envio confirmado', 'Pessoas com entrega confirmada',
        'Pessoas que responderam', 'Sem resposta entre contatados', 'Taxa de resposta (%)', 'Mensagens', 'Mensagens com falha'],
      [row(`CONSOLIDADO — ${report.survey.name}`, report.totals), ...report.executions.map((execution) => row(execution.name, execution))],
    );
  }
}

export function consolidateSurvey(campaigns: CampaignRecord[], messages: MessageRow[], responses: ResponseRow[]) {
  const keyOf = (message: MessageRow) => message.phone ? `phone:${message.phone}` : `contact:${message.contact_id || message.id}`;
  const byMessage = new Map(messages.map((message) => [JSON.stringify([message.campaign_id, message.id]), keyOf(message)]));
  const byContact = new Map<string, Set<string>>();
  const audience = new Set(messages.map(keyOf));
  for (const message of messages) {
    const key = JSON.stringify([message.campaign_id, message.contact_id]);
    const people = byContact.get(key) ?? new Set<string>();
    people.add(keyOf(message)); byContact.set(key, people);
  }
  const matched = responses.map((response) => {
    const messageKey = response.campaign_message_id ? byMessage.get(JSON.stringify([response.campaign_id, response.campaign_message_id])) : undefined;
    const phoneKey = response.phone ? `phone:${response.phone}` : undefined;
    const contacts = byContact.get(JSON.stringify([response.campaign_id, response.contact_id]));
    // Mensagem explícita primeiro; telefone do WhatsApp em seguida. Contato ambíguo não é adivinhado.
    const person = messageKey ?? (phoneKey && audience.has(phoneKey) ? phoneKey :
      contacts?.size === 1 ? [...contacts][0] : undefined);
    return { ...response, person };
  });
  const summarize = (rows: MessageRow[], answers: typeof matched) => {
    const people = new Set(rows.map(keyOf));
    const responded = new Set(answers.flatMap((answer) => answer.person && people.has(answer.person) ? [answer.person] : []));
    const contacted = new Set([...rows.filter((message) => message.sent).map(keyOf), ...responded]);
    const delivered = new Set(rows.filter((message) => message.delivered).map(keyOf));
    return { audience: people.size, contacted: contacted.size, delivered: delivered.size,
      responded: responded.size, unanswered: contacted.size - responded.size,
      responseRate: contacted.size ? Math.round(responded.size / contacted.size * 1000) / 10 : 0,
      messages: rows.length, failedMessages: rows.filter((message) => message.failed).length };
  };
  return {
    totals: summarize(messages, matched),
    unmatchedResponses: matched.filter((response) => !response.person).length,
    lastResponseAt: responses.reduce<string | null>((latest, response) => !latest || response.completed_at > latest ? response.completed_at : latest, null),
    executions: campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, status: campaign.status,
      startedAt: campaign.startedAt ?? campaign.createdAt,
      ...summarize(messages.filter((message) => message.campaign_id === campaign.id), matched.filter((response) => response.campaign_id === campaign.id)),
    })),
  };
}
