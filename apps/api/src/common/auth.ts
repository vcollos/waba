import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE = 'public_route';
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
