import { Controller, Get, Query, Req } from '@nestjs/common';
import { UserSession } from '../database/types';
import { LibraryService } from './library.service';

@Controller('library')
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get('templates')
  templates(
    @Req() request: { user: UserSession },
    @Query('integrationId') integrationId?: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.libraryService.templates(request.user, integrationId, clientId);
  }

  @Get('flows')
  flows(
    @Req() request: { user: UserSession },
    @Query('integrationId') integrationId?: string,
    @Query('clientId') clientId?: string,
  ) {
    return this.libraryService.flows(request.user, integrationId, clientId);
  }
}
