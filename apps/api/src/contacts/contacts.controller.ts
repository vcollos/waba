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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { resolveClientScope } from '../common/scope';
import { ContactsService } from './contacts.service';
import { UserSession } from '../database/types';

// Escrita de contatos/listas: Collos + papéis operacionais do tenant. `viewer`
// (somente leitura) fica de fora — as rotas GET não têm @Roles, então seguem
// liberadas a qualquer papel autenticado (escopadas por tenant no service).
const CONTACTS_WRITE_ROLES = ['super_admin', 'admin', 'client_admin', 'operator'] as const;

@Controller()
@UseGuards(RolesGuard)
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
  @Roles(...CONTACTS_WRITE_ROLES)
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
  @Roles(...CONTACTS_WRITE_ROLES)
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
    @Query('clientId') clientId?: string,
  ) {
    return this.contactsService.updateContact(id, body, request.user, clientId ?? null);
  }

  @Delete('contacts/:id')
  @Roles(...CONTACTS_WRITE_ROLES)
  deleteContact(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.contactsService.deleteContact(id, request.user);
  }

  @Post('contacts/bulk')
  @Roles(...CONTACTS_WRITE_ROLES)
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
  list(
    @Param('id') id: string,
    @Req() request: { user: UserSession },
    @Query('clientId') clientId?: string,
  ) {
    return this.contactsService.getList(id, resolveClientScope(request.user, clientId));
  }

  @Post('lists')
  @Roles(...CONTACTS_WRITE_ROLES)
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
  @Roles(...CONTACTS_WRITE_ROLES)
  updateList(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string | null },
    @Req() request: { user: UserSession },
    @Query('clientId') clientId?: string,
  ) {
    return this.contactsService.updateList(id, body, request.user, clientId ?? null);
  }

  @Delete('lists/:id')
  @Roles(...CONTACTS_WRITE_ROLES)
  deleteList(
    @Param('id') id: string,
    @Req() request: { user: UserSession },
    @Query('clientId') clientId?: string,
  ) {
    return this.contactsService.deleteList(id, request.user, clientId ?? null);
  }

  @Delete('lists/:id/members/:contactId')
  @Roles(...CONTACTS_WRITE_ROLES)
  removeListMember(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Req() request: { user: UserSession },
    @Query('clientId') clientId?: string,
  ) {
    return this.contactsService.removeListMember(id, contactId, request.user, clientId ?? null);
  }

  @Post('contacts/imports/csv/preview')
  @Roles(...CONTACTS_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file'))
  previewCsv(@UploadedFile() file: { originalname: string; buffer: Buffer }) {
    return this.contactsService.previewCsvImport({
      fileName: file.originalname,
      content: file.buffer,
    });
  }

  @Post('contacts/imports/csv')
  @Roles(...CONTACTS_WRITE_ROLES)
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
  @Roles(...CONTACTS_WRITE_ROLES)
  optOut(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.contactsService.setOptOut(id, request.user);
  }

  @Post('contacts/:id/opt-in')
  @Roles(...CONTACTS_WRITE_ROLES)
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
