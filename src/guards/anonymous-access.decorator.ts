import { SetMetadata } from '@nestjs/common';

export const ANONYMOUS_ACCESS = 'circle:anonymous-access';
/** Method-only exemption from app JWT auth; alternate credentials still apply. */
export const AnonymousAccess = (reason: string): MethodDecorator =>
  SetMetadata(ANONYMOUS_ACCESS, reason);
