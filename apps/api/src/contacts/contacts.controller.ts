import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { resolveClientScope } from '../common/scope';
import { ContactsService } from './contacts.service';
import { UserSession } from '../database/types';

@Controller()
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @Get('contacts')
  contacts(
    @Req() request: { user: UserSession },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('clientId') clientId?: string,
  ) {
    const scope = resolveClientScope(request.user, clientId);
    if (limit !== undefined || offset !== undefined) {
      return this.contactsService.listContactsPage(
        {
          limit: limit ? Number(limit) : undefined,
          offset: offset ? Number(offset) : undefined,
        },
        scope,
      );
    }

    return this.contactsService.listContacts(scope);
  }

  @Post('contacts')
  createContact(
    @Body()
    body: {
      clientId?: string | null;
      clientName?: string | null;
      firstName?: string;
      lastName?: string | null;
      phone?: string;
      category?: string | null;
      recordStatus?: string | null;
      email?: string | null;
      externalRef?: string | null;
      listIds?: string[];
    },
    @Req() request: { user: UserSession },
  ) {
    return this.contactsService.createContact(body, request.user);
  }

  @Patch('contacts/:id')
  updateContact(
    @Param('id') id: string,
    @Body()
    body: {
      clientName?: string | null;
      firstName?: string;
      lastName?: string | null;
      phone?: string;
      category?: string | null;
      recordStatus?: string | null;
      email?: string | null;
      externalRef?: string | null;
      listIds?: string[];
    },
    @Req() request: { user: UserSession },
  ) {
    return this.contactsService.updateContact(id, body, request.user);
  }

  @Delete('contacts/:id')
  deleteContact(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.contactsService.deleteContact(id, request.user);
  }

  @Post('contacts/bulk')
  bulkAction(
    @Body()
    body: {
      action?:
        | 'activate'
        | 'deactivate'
        | 'opt_out'
        | 'opt_in'
        | 'delete'
        | 'assign_list'
        | 'set_category'
        | 'set_client';
      contactIds?: string[];
      listId?: string;
      category?: string | null;
      clientName?: string | null;
    },
    @Req() request: { user: UserSession },
  ) {
    return this.contactsService.bulkAction(
      {
        action: body.action ?? 'activate',
        contactIds: body.contactIds ?? [],
        listId: body.listId,
        category: body.category,
        clientName: body.clientName,
      },
      request.user,
    );
  }

  @Get('lists')
  lists(@Req() request: { user: UserSession }, @Query('clientId') clientId?: string) {
    return this.contactsService.listLists(resolveClientScope(request.user, clientId));
  }

  @Get('lists/:id')
  list(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.contactsService.getList(id, resolveClientScope(request.user));
  }

  @Post('lists')
  createList(
    @Body() body: { name?: string; description?: string; clientId?: string | null },
    @Req() request: { user: UserSession },
  ) {
    return this.contactsService.createList(
      { name: body.name ?? 'Nova lista', description: body.description, clientId: body.clientId },
      request.user,
    );
  }

  @Patch('lists/:id')
  updateList(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string | null },
    @Req() request: { user: UserSession },
  ) {
    return this.contactsService.updateList(id, body, request.user);
  }

  @Delete('lists/:id')
  deleteList(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.contactsService.deleteList(id, request.user);
  }

  @Delete('lists/:id/members/:contactId')
  removeListMember(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Req() request: { user: UserSession },
  ) {
    return this.contactsService.removeListMember(id, contactId, request.user);
  }

  @Post('contacts/imports/csv/preview')
  @UseInterceptors(FileInterceptor('file'))
  previewCsv(@UploadedFile() file: { originalname: string; buffer: Buffer }) {
    return this.contactsService.previewCsvImport({
      fileName: file.originalname,
      content: file.buffer,
    });
  }

  @Post('contacts/imports/csv')
  @UseInterceptors(FileInterceptor('file'))
  async importCsv(
    @UploadedFile() file: { originalname: string; buffer: Buffer },
    @Body()
    body: {
      listName?: string;
      clientId?: string;
      mapping?: string;
      defaults?: string;
    },
    @Req() request: { user: UserSession },
  ) {
    return this.contactsService.startCsvImport(
      {
        listName: body.listName ?? file.originalname.replace(/\.[^.]+$/, ''),
        fileName: file.originalname,
        content: file.buffer,
        clientId: body.clientId ?? null,
        mapping: parseJsonBody(body.mapping),
        defaults: parseJsonBody(body.defaults),
      },
      request.user,
    );
  }

  @Get('contacts/imports/csv/jobs/:id')
  getCsvImportJob(@Param('id') id: string) {
    return this.contactsService.getCsvImportJob(id);
  }

  @Post('contacts/:id/opt-out')
  optOut(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.contactsService.setOptOut(id, request.user);
  }

  @Post('contacts/:id/opt-in')
  optIn(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.contactsService.clearOptOut(id, request.user);
  }
}

const parseJsonBody = <T>(value?: string): T | undefined => {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};
