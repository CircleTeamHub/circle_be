import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthErrorCode } from 'src/common/app-error-codes';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logSecurityEvent } from 'src/logging/security-event.logger';

/**
 * 可选的密保问题。前端按 key 显示文案（i18n `securityQuestions.questions.<key>`），
 * 两端逐项镜像：这里增删要同步前端 SECURITY_QUESTION_KEYS。
 */
export const SECURITY_QUESTION_KEYS = [
  'bestFriendName',
  'primarySchool',
  'firstTeacher',
  'childhoodNickname',
  'birthCity',
  'firstPetName',
  'motherName',
  'fatherName',
] as const;

/** 每个账号设置的密保问题数量。 */
export const SECURITY_QUESTION_COUNT = 2;
export const SECURITY_ANSWER_MAX_LENGTH = 64;

/**
 * 答案规范化：全角半角统一、去掉所有空白、不分大小写。设置和验证都过这一道，
 * 「张 三」「Ｓｕｎｓｈｉｎｅ」这类输入差异不至于把本人挡在外面。
 */
export function normalizeSecurityAnswer(answer: string): string {
  return answer.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export type SecurityQuestionAnswer = { questionKey: string; answer: string };

/**
 * 密保问题：陌生设备登录时受信任设备都不在身边的兜底（与登录安全码同级）。
 * 答案只存 argon2 哈希；登录时的次数上限由 DeviceTrustService 的验证单计次负责。
 */
@Injectable()
export class SecurityQuestionsService {
  private readonly logger = new Logger(SecurityQuestionsService.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(private readonly prisma: PrismaService) {}

  /** 已设置的问题 key（按设置顺序）；没设置为空数组。 */
  async questionKeys(userId: string): Promise<string[]> {
    const rows = await this.prisma.userSecurityQuestion.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: { questionKey: true },
    });
    return rows.map((row) => row.questionKey);
  }

  /**
   * 设置 / 替换密保。必须核对当前密码：否则偷到一枚登录态就能给自己配一条
   * 登录兜底，再拿去别的设备免批准登录。
   */
  async set(
    userId: string,
    password: string,
    questions: SecurityQuestionAnswer[],
  ): Promise<void> {
    const keys = questions.map((question) => question.questionKey);
    const answers = questions.map((question) =>
      normalizeSecurityAnswer(question.answer),
    );
    if (
      new Set(keys).size !== SECURITY_QUESTION_COUNT ||
      answers.some((answer) => !answer)
    ) {
      throw new BadRequestException({
        message: '请选择两个不同的问题并填写答案',
        errorCode: AuthErrorCode.SecurityQuestionsInvalid,
      });
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user || !(await argon2.verify(user.passwordHash, password))) {
      throw new ForbiddenException({
        message: '当前密码不正确',
        errorCode: AuthErrorCode.PasswordIncorrect,
      });
    }
    const hashes = await Promise.all(
      answers.map((answer) => argon2.hash(answer)),
    );
    await this.prisma.$transaction([
      this.prisma.userSecurityQuestion.deleteMany({ where: { userId } }),
      this.prisma.userSecurityQuestion.createMany({
        data: keys.map((questionKey, position) => ({
          userId,
          questionKey,
          answerHash: hashes[position],
          position,
        })),
      }),
    ]);
    logSecurityEvent(this.logger, {
      enabled: this.loggingConfig.securityLogOn,
      securityEvent: 'security_questions_set',
      statusCode: 200,
      userId,
      metadata: {},
    });
  }

  /** 按设置顺序核对两个答案；没设置密保时恒为 false。 */
  async verifyAnswers(userId: string, answers: string[]): Promise<boolean> {
    const rows = await this.prisma.userSecurityQuestion.findMany({
      where: { userId },
      orderBy: { position: 'asc' },
      select: { answerHash: true },
    });
    if (rows.length !== SECURITY_QUESTION_COUNT) return false;
    const results = await Promise.all(
      rows.map((row, index) =>
        argon2.verify(
          row.answerHash,
          normalizeSecurityAnswer(answers[index] ?? ''),
        ),
      ),
    );
    return results.every(Boolean);
  }
}
