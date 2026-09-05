import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CLIENT_MESSAGE_TYPES,
  HISTORY_FILTER_MESSAGE_TYPES,
  SYSTEM_MESSAGE_TYPE,
} from '../chat.constants';
import { HistoryQueryDto } from './history-query.dto';

async function validateTypes(types: unknown) {
  return validate(plainToInstance(HistoryQueryDto, { types }));
}

describe('HistoryQueryDto types filter', () => {
  // 群管理日志按 system 拉历史。读路径的可见性已经由成员资格 + clearedBeforeHeight
  // 决定，types 只是在已授权结果里再筛一道，所以过滤白名单必须比发送白名单宽。
  // 复用发送白名单会让群日志的每一次加载都 400。
  it('accepts the system type so the group management log can be queried', async () => {
    expect(await validateTypes([SYSTEM_MESSAGE_TYPE])).toHaveLength(0);
    expect(await validateTypes(SYSTEM_MESSAGE_TYPE)).toHaveLength(0);
  });

  it('accepts every client-sendable type', async () => {
    expect(await validateTypes([...CLIENT_MESSAGE_TYPES])).toHaveLength(0);
  });

  it('still rejects types that are not real message types', async () => {
    const errors = await validateTypes(['not-a-message-type']);
    expect(errors.length).toBeGreaterThan(0);
  });

  // 放宽的只是读过滤。发送白名单是安全边界，system 必须仍然不在里面，
  // 否则客户端就能自己伪造「管理员移除了某人」这类系统消息。
  it('does not widen what a client may send', () => {
    expect(CLIENT_MESSAGE_TYPES as readonly string[]).not.toContain(
      SYSTEM_MESSAGE_TYPE,
    );
    expect(HISTORY_FILTER_MESSAGE_TYPES).toContain(SYSTEM_MESSAGE_TYPE);
  });
});
