import { Controller, Get, Query } from '@nestjs/common';
import { ResultsService } from './results.service';

@Controller('results')
export class ResultsController {
  constructor(private readonly resultsService: ResultsService) {}

  @Get('flow-responses')
  flowResponses(
    @Query('campaignId') campaignId?: string,
    @Query('flowCacheId') flowCacheId?: string,
    @Query('contactId') contactId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.resultsService.listFlowResponses({
      campaignId,
      flowCacheId,
      contactId,
      limit: normalizeLimit(limit),
    });
  }

  @Get('summary')
  summary() {
    return this.resultsService.summary();
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
