import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { Public } from '../common/auth';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: { email?: string; password?: string }) {
    return this.authService.login(body.email ?? '', body.password ?? '');
  }

  @Get('me')
  me(@Req() request: { user: { id: string; email: string; role: string } }) {
    return request.user;
  }
}
