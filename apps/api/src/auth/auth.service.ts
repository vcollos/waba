import { Injectable, UnauthorizedException } from '@nestjs/common';
import { sign } from 'jsonwebtoken';
import { getEnv } from '../common/env';
import { Role, UserSession } from '../database/types';

@Injectable()
export class AuthService {
  login(email: string, password: string): { token: string; user: UserSession } {
    const env = getEnv();
    if (email !== env.adminEmail || password !== env.adminPassword) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const user: UserSession = {
      id: 'pilot-admin',
      email,
      role: 'admin' satisfies Role,
    };

    return {
      token: sign(user, env.jwtSecret, { expiresIn: '12h' }),
      user,
    };
  }
}
