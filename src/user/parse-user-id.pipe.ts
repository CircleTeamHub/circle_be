import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import {
  normalizeUserIdAlias,
  USER_ID_OR_ALIAS_PATTERN,
} from './user-id-alias';

@Injectable()
export class ParseUserIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !USER_ID_OR_ALIAS_PATTERN.test(value)) {
      throw new BadRequestException('Invalid user ID');
    }
    return normalizeUserIdAlias(value);
  }
}
