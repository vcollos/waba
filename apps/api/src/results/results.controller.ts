import { Controller, Get, Query, Req, Res } from '@nestjs/common';
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
