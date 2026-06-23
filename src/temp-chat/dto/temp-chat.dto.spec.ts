import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTempChatDto } from './create-temp-chat.dto';
import { JoinTempChatDto } from './join-temp-chat.dto';

const errKeys = (obj: unknown, cls: any) =>
  validateSync(plainToInstance(cls, obj)).map((e) => e.property);

describe('CreateTempChatDto', () => {
  it('accepts empty body (all optional, defaults applied later)', () => {
    expect(errKeys({}, CreateTempChatDto)).toEqual([]);
  });
  it('rejects ttl below 30', () => {
    expect(errKeys({ ttlMinutes: 10 }, CreateTempChatDto)).toContain(
      'ttlMinutes',
    );
  });
  it('rejects ttl above 10080', () => {
    expect(errKeys({ ttlMinutes: 99999 }, CreateTempChatDto)).toContain(
      'ttlMinutes',
    );
  });
  it('rejects maxMembers above 50', () => {
    expect(errKeys({ maxMembers: 51 }, CreateTempChatDto)).toContain(
      'maxMembers',
    );
  });
  it('rejects maxMembers below 2', () => {
    expect(errKeys({ maxMembers: 1 }, CreateTempChatDto)).toContain(
      'maxMembers',
    );
  });
  it('rejects title longer than 30', () => {
    expect(errKeys({ title: 'x'.repeat(31) }, CreateTempChatDto)).toContain(
      'title',
    );
  });
});

describe('JoinTempChatDto', () => {
  it('accepts empty body', () => {
    expect(errKeys({}, JoinTempChatDto)).toEqual([]);
  });
  it('rejects displayName longer than 20', () => {
    expect(errKeys({ displayName: 'x'.repeat(21) }, JoinTempChatDto)).toContain(
      'displayName',
    );
  });
});
