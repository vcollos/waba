import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ResultsService } from './results.service';

@Controller('results')
export class ResultsController {
  constructor(private readonly resultsService: ResultsService) {}

  @Get('flow-responses')
  flowResponses(
    @Query('campaignId') campaignId?: string,
    @Query('flowCacheId') flowCacheId?: string,
    @Query('flowName') flowName?: string,
    @Query('contactId') contactId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.resultsService.listFlowResponses({
      campaignId,
      flowCacheId,
      flowName,
      contactId,
      limit: normalizeLimit(limit),
    });
  }

  @Get('summary')
  summary() {
    return this.resultsService.summary();
  }

  @Get('flow-responses/export.csv')
  async exportFlowResponsesCsv(
    @Res() response: Response,
    @Query('campaignId') campaignId?: string,
    @Query('flowCacheId') flowCacheId?: string,
    @Query('flowName') flowName?: string,
    @Query('contactId') contactId?: string,
    @Query('limit') limit?: string,
  ) {
    const csv = await this.resultsService.exportFlowResponsesCsv({
      campaignId,
      flowCacheId,
      flowName,
      contactId,
      limit: normalizeLimit(limit),
    });
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
