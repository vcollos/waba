import { Injectable, UnauthorizedException } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { getEnv } from '../common/env';
import { verifyPassword } from '../common/password';
import { DatabaseService } from '../database/database.service';
import { UserSession } from '../database/types';

@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}

  async login(email: string, password: string): Promise<{ token: string; user: UserSession }> {
    const env = getEnv();
    const user = await this.database.findUserByEmail(email);

    if (!user || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const session: UserSession = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      clientIds: user.clientIds ?? [],
    };

    await this.database.touchUserLogin(user.id, new Date().toISOString());

    return {
      token: sign(session, env.jwtSecret, { expiresIn: '12h' }),
      user: session,
    };
  }
}
