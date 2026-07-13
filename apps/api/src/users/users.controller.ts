import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { UserFilters, UserInput, UsersService } from './users.service';

@Controller('users')
@UseGuards(RolesGuard)
@Roles('super_admin', 'admin')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list(@Query() query: UserFilters) {
    return this.usersService.list(query);
  }

  @Post()
  create(@Body() body: UserInput) {
    return this.usersService.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UserInput) {
    return this.usersService.update(id, body);
  }
}
