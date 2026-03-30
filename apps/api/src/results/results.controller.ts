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
  ) {
    return this.resultsService.listFlowResponses({ campaignId, flowCacheId, contactId });
  }

  @Get('summary')
  summary() {
    return this.resultsService.summary();
  }
}
