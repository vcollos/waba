import { SetMetadata } from '@nestjs/common';
import { Role } from '../database/types';

export const ROLES_KEY = 'required_roles';

/** Restringe uma rota aos papéis informados (verificado pelo RolesGuard). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
