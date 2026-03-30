import { Controller, Get, Query } from '@nestjs/common';
import { LibraryService } from './library.service';

@Controller('library')
export class LibraryController {
  constructor(private readonly libraryService: LibraryService) {}

  @Get('templates')
  templates(@Query('integrationId') integrationId?: string) {
    return this.libraryService.templates(integrationId);
  }

  @Get('flows')
  flows(@Query('integrationId') integrationId?: string) {
    return this.libraryService.flows(integrationId);
  }
}
