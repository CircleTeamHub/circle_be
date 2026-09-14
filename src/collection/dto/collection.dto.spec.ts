import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCollectionDto } from './collection.dto';

// 与全局 ValidationPipe 同一组选项（src/setup.ts）。
function payloadErrors(payload: Record<string, unknown>) {
  const dto = plainToInstance(
    CreateCollectionDto,
    { type: 'MESSAGE', title: '收藏', sourceID: 'message-1', payload },
    { enableImplicitConversion: true },
  );
  return validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).filter((error) => error.property === 'payload');
}

/**
 * APP 的 buildCollectionInputFromMessage 拼出的消息快照，元数据按各自上限取满：
 * 客户端消息 id ≤ 128、群名/备注/昵称远短于 60、sourceID ≤ 120。
 */
function appMessageSnapshot(extra: Record<string, unknown>) {
  return {
    kind: 'openim-message',
    messageID: 'm'.repeat(128),
    messageType: 'received',
    conversationID: 'c'.repeat(128),
    conversationTitle: '群'.repeat(60),
    sourceID: 's'.repeat(120),
    conversationType: 'group',
    senderID: '00000000-0000-4000-8000-000000000001',
    senderName: '昵'.repeat(60),
    time: '2026-09-13T08:00:00.000Z',
    ...extra,
  };
}

// payload 此前只有 @IsObject：一条请求就能往 UserCollection.payload（JSONB）里塞进
// 任意大的文档。上限 8192（JSON.stringify 后的长度）必须装得下 APP 真实会发的快照。
describe('CreateCollectionDto payload size', () => {
  it('accepts the largest text snapshot the app builds (a 4000-character message)', () => {
    // 聊天正文上限 MAX_TEXT_LENGTH = 4000（chat.constants.ts）。
    expect(
      payloadErrors(appMessageSnapshot({ text: '好'.repeat(4000) })),
    ).toHaveLength(0);
    expect(
      payloadErrors(appMessageSnapshot({ text: '一行文字\n'.repeat(800) })),
    ).toHaveLength(0);
  });

  it('accepts media snapshots carrying long presigned URLs', () => {
    const presigned = `https://bucket.cos.ap-tokyo.myqcloud.com/chat/u/v.m4a?${'q'.repeat(1900)}`;
    expect(
      payloadErrors(
        appMessageSnapshot({
          messageType: 'voice',
          voice: {
            key: 'chat/user-1/voice.m4a',
            sourceUrl: presigned,
            soundPath: `file:///data/user/0/app/cache/${'p'.repeat(200)}.m4a`,
            duration: 59,
            dataSize: 480_000,
          },
        }),
      ),
    ).toHaveLength(0);
    expect(
      payloadErrors(
        appMessageSnapshot({
          messageType: 'image',
          image: { url: presigned, width: 1080, height: 1920 },
        }),
      ),
    ).toHaveLength(0);
  });

  it('accepts a friend-card snapshot with an avatar and four icon URLs', () => {
    // 预签名读地址（SigV4，无 STS token）实际约 500–600 字符；这里每个给到约 950。
    const url = (n: number) =>
      `https://bucket.cos.ap-tokyo.myqcloud.com/icons/${n}.png?${'q'.repeat(900)}`;
    expect(
      payloadErrors(
        appMessageSnapshot({
          messageType: 'friend-card',
          friendCard: {
            userID: 'u'.repeat(64),
            nickname: '昵'.repeat(60),
            faceURL: url(0),
            persona: '签'.repeat(120),
            displayIcons: [1, 2, 3, 4].map((n) => ({
              id: `icon-${n}`.padEnd(64, 'x'),
              type: 'CIRCLE',
              title: '标'.repeat(40),
              imageUrl: url(n),
              fallbackIconName: 'people-circle-outline',
              sortOrder: n,
            })),
          },
        }),
      ),
    ).toHaveLength(0);
  });

  it('accepts the legacy note-card snapshot older app builds still send', () => {
    expect(
      payloadErrors(
        appMessageSnapshot({
          messageType: 'note-card',
          noteCard: {
            noteId: '00000000-0000-4000-8000-000000000002',
            title: '标'.repeat(100),
            excerpt: '摘'.repeat(500),
            coverUrl: `https://cdn.example.com/${'c'.repeat(500)}.jpg`,
            ownerId: '00000000-0000-4000-8000-000000000003',
            ownerName: '昵'.repeat(60),
          },
        }),
      ),
    ).toHaveLength(0);
  });

  it('rejects a payload that serializes to more than 8192 characters', () => {
    const [error] = payloadErrors({ text: 'x'.repeat(8192) });
    expect(error?.constraints).toHaveProperty('maxJsonLength');
  });
});
