import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { resolveClientScope } from '../common/scope';
import { UserSession } from '../database/types';
import { ResultsService } from './results.service';

@Controller('results')
export class ResultsController {
  constructor(private readonly resultsService: ResultsService) {}

  @Get('flow-responses')
  flowResponses(
    @Req() request: { user: UserSession },
    @Query('campaignId') campaignId?: string,
    @Query('flowCacheId') flowCacheId?: string,
    @Query('flowName') flowName?: string,
    @Query('contactId') contactId?: string,
    @Query('limit') limit?: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.resultsService.listFlowResponses(
      { campaignId, flowCacheId, flowName, contactId, limit: normalizeLimit(limit) },
      resolveClientScope(request.user, clientId),
    );
  }

  @Get('summary')
  summary(@Req() request: { user: UserSession }, @Query('clientId') clientId?: string) {
    return this.resultsService.summary(resolveClientScope(request.user, clientId));
  }

  /** Campanhas que têm respostas — uma tabela por campanha. */
  @Get('campaigns')
  campaignsWithResponses(@Req() request: { user: UserSession }, @Query('clientId') clientId?: string) {
    return this.resultsService.listCampaignsWithResponses(resolveClientScope(request.user, clientId));
  }

  /** Tabela crua das respostas da campanha: campos do flow viram colunas. */
  @Get('campaigns/:campaignId/table')
  campaignTable(
    @Param('campaignId') campaignId: string,
    @Req() request: { user: UserSession },
    @Query('clientId') clientId?: string,
  ) {
    return this.resultsService.buildCampaignResponseTable(
      campaignId,
      resolveClientScope(request.user, clientId),
    );
  }

  @Get('campaigns/:campaignId/table.csv')
  async exportCampaignTableCsv(
    @Param('campaignId') campaignId: string,
    @Req() request: { user: UserSession },
    @Res() response: Response,
    @Query('clientId') clientId?: string,
    @Query('respondeu') respondeu?: string,
    @Query('situacao') situacao?: string,
    @Query('search') search?: string,
  ) {
    const csv = await this.resultsService.exportCampaignResponseTableCsv(
      campaignId,
      resolveClientScope(request.user, clientId),
      { respondeu, situacao, search },
    );
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="respostas-${campaignId}.csv"`);
    response.send(csv);
  }

  @Get('flow-responses/export.csv')
  async exportFlowResponsesCsv(
    @Req() request: { user: UserSession },
    @Res() response: Response,
    @Query('campaignId') campaignId?: string,
    @Query('flowCacheId') flowCacheId?: string,
    @Query('flowName') flowName?: string,
    @Query('contactId') contactId?: string,
    @Query('limit') limit?: string,
    @Query('clientId') clientId?: string,
  ) {
    const csv = await this.resultsService.exportFlowResponsesCsv(
      { campaignId, flowCacheId, flowName, contactId, limit: normalizeLimit(limit) },
      resolveClientScope(request.user, clientId),
    );
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="flow-responses.csv"');
    response.send(csv);
  }
}

const normalizeLimit = (value?: string): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.min(parsed, 1000);
};
