import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SurveyReportsService } from './survey-reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, SurveyReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
