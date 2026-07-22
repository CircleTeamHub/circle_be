import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { EmailCodePurpose } from 'src/generated/prisma';
import { Mailer } from './mailer.interface';

// 连接/握手/收发同一上限：10s 内没走完某一阶段就放弃，交给上游报可控错误。
const SMTP_TIMEOUT_MS = 10_000;

/**
 * 真实 SMTP Mailer（#82）。
 *
 * 由 auth.module 的 MAILER factory 在 SMTP_HOST 存在时选用；配置齐备性由
 * env.validation 保证（设了 host 未配凭据在启动期就炸）。465 默认走隐式 TLS，
 * 587 走 STARTTLS（secure=false + requireTLS），明文投递永不允许 —— 验证码
 * 走明文等于把一次性登录凭据广播给路径上的所有人。
 *
 * 发送失败原样抛出：上游 EmailVerificationService 已把「发信失败」作为用户可见
 * 错误处理，静默吞掉会让用户对着永远不来的验证码反复重试。
 */
@Injectable()
export class SmtpMailer implements Mailer {
  private readonly logger = new Logger('SmtpMailer');
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(configService: ConfigService) {
    const host = configService.get<string>('SMTP_HOST');
    const port = Number(configService.get('SMTP_PORT') ?? 465);
    const secure =
      String(configService.get('SMTP_SECURE') ?? 'true') !== 'false';
    const user = configService.get<string>('SMTP_USER');
    const pass = configService.get<string>('SMTP_PASS');
    this.from = configService.get<string>('MAIL_FROM') ?? user ?? '';

    this.transporter = createTransport({
      host,
      port,
      secure,
      // secure=false 时（587/STARTTLS）仍强制 TLS 升级，拒绝明文降级。
      requireTLS: !secure,
      auth: user && pass ? { user, pass } : undefined,
      // review 修复：request-code 是未认证端点且 sendMail 内联在请求里 ——
      // SMTP 服务器接了连接却停在 greeting/DATA 时，缺省超时会让请求挂到
      // 平台级超时并在降级期堆积。三段都钉在秒级。
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }

  private subjectFor(purpose: EmailCodePurpose): string {
    switch (purpose) {
      case EmailCodePurpose.REGISTER:
        return '【风信】注册验证码';
      case EmailCodePurpose.LOGIN:
        return '【风信】登录验证码';
      default:
        return '【风信】验证码';
    }
  }

  async sendVerificationCode(
    email: string,
    code: string,
    purpose: EmailCodePurpose,
  ): Promise<void> {
    const subject = this.subjectFor(purpose);
    await this.transporter.sendMail({
      from: this.from,
      to: email,
      subject,
      text: `你的验证码是 ${code}，10 分钟内有效。如果这不是你本人的操作，请忽略本邮件。`,
      html: [
        '<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">',
        `<h2 style="margin:0 0 16px">${subject}</h2>`,
        `<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:16px 0">${code}</p>`,
        '<p style="color:#666">验证码 10 分钟内有效。如果这不是你本人的操作，请忽略本邮件。</p>',
        '</div>',
      ].join(''),
    });
    // 不打 email 全文到日志（PII）；打脱敏域名便于排障。
    const domain = email.split('@')[1] ?? 'unknown';
    this.logger.log(`verification code sent (${purpose}) to *@${domain}`);
  }
}
