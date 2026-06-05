import {
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db, Document, MongoClient } from 'mongodb';
import { OpenimService } from 'src/openim/openim.service';
import {
  ChatHistoryMessagePageDto,
  RestorableMessageDto,
} from './dto/chat-history.dto';

type MessageAggregationResult = {
  stats?: Array<{
    serverMinSeq?: unknown;
    serverMaxSeq?: unknown;
  }>;
  page?: Document[];
};

@Injectable()
export class ChatHistoryService implements OnModuleDestroy {
  private mongoClient: MongoClient | null = null;
  private mongoDb: Db | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy() {
    await this.mongoClient?.close();
  }

  async getMessages(
    userId: string,
    conversationID: string,
    limit = 100,
    beforeSeq?: number,
  ): Promise<ChatHistoryMessagePageDto> {
    const currentImUserID = OpenimService.toImUserId(userId);
    await this.validateConversationAccess(conversationID, currentImUserID);
    const db = await this.getMongoDb();
    const pageSize = Math.max(1, Math.min(200, Number(limit) || 100));
    const [result] = (await db
      .collection('msg')
      .aggregate(
        this.buildMessagePagePipeline(
          conversationID,
          currentImUserID,
          pageSize,
          beforeSeq,
        ),
      )
      .toArray()) as MessageAggregationResult[];
    const stats = result?.stats?.[0];
    const pageWrappers = result?.page ?? [];
    const hasMore = pageWrappers.length > pageSize;
    const messages = pageWrappers
      .slice(0, pageSize)
      .map((wrapper) => this.toRestorableMessage(wrapper))
      .filter((message) => Number.isFinite(message.seq))
      .sort((left, right) => left.seq - right.seq);
    const nextBeforeSeq = messages.length > 0 ? messages[0].seq : null;
    const serverMinSeq =
      stats?.serverMinSeq == null ? null : this.toNumber(stats.serverMinSeq);
    const serverMaxSeq =
      stats?.serverMaxSeq == null ? null : this.toNumber(stats.serverMaxSeq);

    return {
      conversationID,
      messages,
      hasMore,
      nextBeforeSeq,
      serverMinSeq,
      serverMaxSeq,
    };
  }

  private buildMessagePagePipeline(
    conversationID: string,
    currentImUserID: string,
    pageSize: number,
    beforeSeq?: number,
  ): Document[] {
    const pagePipeline: Document[] = [];
    if (beforeSeq != null) {
      pagePipeline.push({ $match: { 'msg.seq': { $lt: beforeSeq } } });
    }
    pagePipeline.push(
      { $sort: { 'msg.seq': -1 } },
      { $limit: pageSize + 1 },
    );

    return [
      { $match: { doc_id: { $regex: `^${this.escapeRegex(conversationID)}:` } } },
      { $project: { msgs: 1 } },
      { $unwind: '$msgs' },
      { $replaceRoot: { newRoot: '$msgs' } },
      {
        $match: {
          msg: { $ne: null },
          'msg.seq': { $exists: true },
          del_list: { $ne: currentImUserID },
        },
      },
      {
        $facet: {
          stats: [
            {
              $group: {
                _id: null,
                serverMaxSeq: { $max: '$msg.seq' },
                serverMinSeq: { $min: '$msg.seq' },
              },
            },
          ],
          page: pagePipeline,
        },
      },
    ];
  }

  private async validateConversationAccess(
    conversationID: string,
    currentImUserID: string,
  ): Promise<{ type: 'single' | 'group'; groupID?: string }> {
    if (conversationID.startsWith('si_')) {
      const participantIDs = conversationID.slice(3).split('_');
      if (
        participantIDs.length !== 2 ||
        participantIDs.some((participantID) => !participantID) ||
        !participantIDs.includes(currentImUserID)
      ) {
        throw new NotFoundException('会话不存在');
      }
      return { type: 'single' };
    }

    if (conversationID.startsWith('sg_')) {
      const groupID = conversationID.slice(3);
      if (!groupID) {
        throw new NotFoundException('会话不存在');
      }
      await this.ensureGroupMember(groupID, currentImUserID);
      return { type: 'group', groupID };
    }

    throw new NotFoundException('会话不存在');
  }

  private async ensureGroupMember(groupID: string, currentImUserID: string) {
    const db = await this.getMongoDb();
    const member = await db.collection('group_member').findOne({
      group_id: groupID,
      user_id: currentImUserID,
    });

    if (!member) {
      throw new NotFoundException('会话不存在');
    }
  }

  private toRestorableMessage(wrapper: Document): RestorableMessageDto {
    const msg = wrapper.msg as Document;
    return {
      clientMsgID: this.toString(msg.client_msg_id),
      serverMsgID: this.toString(msg.server_msg_id),
      sendID: this.toString(msg.send_id),
      recvID: this.toString(msg.recv_id),
      groupID: this.toString(msg.group_id),
      senderNickname: this.toString(msg.sender_nickname),
      senderFaceUrl: this.toString(msg.sender_face_url),
      senderPlatformID: this.toNumber(msg.sender_platform_id),
      sessionType: this.toNumber(msg.session_type),
      msgFrom: this.toNumber(msg.msg_from),
      contentType: this.toNumber(msg.content_type),
      status: this.toNumber(msg.status),
      seq: this.toNumber(msg.seq),
      sendTime: this.toNumber(msg.send_time),
      createTime: this.toNumber(msg.create_time),
      content: this.toString(msg.content),
      attachedInfo: this.toString(msg.attached_info),
      ex: this.toString(msg.ex),
      isRead: Boolean(wrapper.is_read),
    };
  }

  private async getMongoDb(): Promise<Db> {
    if (this.mongoDb) return this.mongoDb;

    const uri = this.getMongoUri();
    if (!uri) {
      throw new ServiceUnavailableException(
        'OpenIM history store is not configured',
      );
    }

    this.mongoClient = new MongoClient(uri, {
      connectTimeoutMS: 3_000,
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 3_000,
    });
    await this.mongoClient.connect();
    this.mongoDb = this.mongoClient.db(this.getMongoDatabase());
    return this.mongoDb;
  }

  private getMongoUri(): string {
    const explicitUri = this.config.get<string>('OPENIM_MONGO_URI');
    if (explicitUri) return explicitUri;

    const address =
      this.config.get<string>('OPENIM_MONGO_ADDRESS') ??
      this.config.get<string>('MONGO_ADDRESS') ??
      '';
    if (!address) return '';

    const username =
      this.config.get<string>('OPENIM_MONGO_USERNAME') ??
      this.config.get<string>('MONGO_USERNAME') ??
      '';
    const password =
      this.config.get<string>('OPENIM_MONGO_PASSWORD') ??
      this.config.get<string>('MONGO_PASSWORD') ??
      '';
    const database = this.getMongoDatabase();

    if (username && password) {
      return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${address}/${database}?authSource=${database}`;
    }
    return `mongodb://${address}/${database}`;
  }

  private getMongoDatabase(): string {
    return (
      this.config.get<string>('OPENIM_MONGO_DATABASE') ??
      this.config.get<string>('MONGO_INITDB_DATABASE') ??
      'openim_v3'
    );
  }

  private toNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (
      value &&
      typeof value === 'object' &&
      'toNumber' in value &&
      typeof (value as { toNumber: () => number }).toNumber === 'function'
    ) {
      return (value as { toNumber: () => number }).toNumber();
    }
    return Number(value ?? 0);
  }

  private toString(value: unknown): string {
    if (value == null) return '';
    return String(value);
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
