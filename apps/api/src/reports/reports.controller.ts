import { Body, Controller, Get, Put, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { resolveClientScope } from '../common/scope';
import { UserSession } from '../database/types';
import { ReportsService } from './reports.service';

// Relatórios expõem valores financeiros: apenas papéis administrativos leem
// (viewer/operator NÃO). @Roles em nível de classe cobre todas as leituras; as
// escritas de tarifa/NF sobrescrevem para Collos-only (@Roles no método vence).
@Controller('reports')
@UseGuards(RolesGuard)
@Roles('super_admin', 'admin', 'client_admin')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('campaigns')
  campaigns(
    @Req() request: { user: UserSession },
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.reportsService.campaignsReport(
      { from, to },
      resolveClientScope(request.user, clientId),
    );
  }

  @Get('campaigns/export.csv')
  async exportCsv(
    @Req() request: { user: UserSession },
    @Res() response: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('clientId') clientId?: string,
  ) {
    const csv = await this.reportsService.campaignsReportCsv(
      { from, to },
      resolveClientScope(request.user, clientId),
    );
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="relatorio-campanhas.csv"');
    response.send(csv);
  }

  @Get('campaigns/export.pdf')
  async exportPdf(
    @Req() request: { user: UserSession },
    @Res() response: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('clientId') clientId?: string,
  ) {
    const html = await this.reportsService.campaignsReportHtml(
      { from, to },
      resolveClientScope(request.user, clientId),
    );
    // Print-ready HTML (browser -> "Salvar como PDF"). Sem headless chrome/pdfkit
    // para não pesar no disco da VPS. Inline para o navegador renderizar.
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Disposition', 'inline; filename="relatorio-campanhas.html"');
    response.send(html);
  }

  @Get('rates')
  rates(@Req() request: { user: UserSession }, @Query('clientId') clientId?: string) {
    return this.reportsService.listRates(resolveClientScope(request.user, clientId));
  }

  @Post('rates')
  @Roles('super_admin', 'admin')
  upsertRate(
    @Req() request: { user: UserSession },
    @Body()
    body: {
      id?: string;
      category?: string;
      unitPriceBrl?: number;
      effectiveFrom?: string;
      clientId?: string | null;
    },
  ) {
    return this.reportsService.upsertRate(request.user, body);
  }

  @Get('settings')
  settings(@Req() request: { user: UserSession }, @Query('clientId') clientId?: string) {
    return this.reportsService.getSettings(resolveClientScope(request.user, clientId));
  }

  @Put('settings')
  @Roles('super_admin', 'admin')
  updateSettings(
    @Req() request: { user: UserSession },
    @Body() body: { notaFiscalPct?: number; clientId?: string | null },
  ) {
    return this.reportsService.updateSettings(request.user, body);
  }
}
