import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { ConsoleRelease, ConsoleReleasePlan } from 'src/generated/prisma';
import type { ReleaseDto, ReleasePlanDto } from './console.dto';

export function stableRollout(installation: string, releaseID: string): number {
  return (
    createHash('sha256')
      .update(`${installation}:${releaseID}`)
      .digest()
      .readUInt32BE(0) % 100
  );
}
export function validateRelease(dto: ReleaseDto) {
  let url: URL;
  try {
    url = new URL(dto.url);
  } catch {
    throw new BadRequestException('更新地址无效');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new BadRequestException('更新地址必须是受信任来源的 HTTPS 地址');
  if (dto.platform === 'android') {
    const [major, minor, patch] = dto.version.split('.').map(Number);
    if (
      minor >= 1000 ||
      patch >= 1000 ||
      major * 1_000_000 + minor * 1000 + patch !== dto.build ||
      url.hostname !== 'github.com' ||
      url.pathname !==
        `/CircleTeamHub/windnote-releases/releases/download/v${dto.version}/windnote.apk`
    )
      throw new BadRequestException('Android 构建号或官方安装包地址不一致');
  } else if (
    url.hostname !== 'apps.apple.com' ||
    !/\/id\d+$/.test(url.pathname)
  ) {
    throw new BadRequestException('iOS 更新必须使用 App Store 地址');
  }
}
export function validatePlan(dto: ReleasePlanDto, release: ConsoleRelease) {
  if (
    release.withdrawnAt ||
    dto.minBuild > dto.maxBuild ||
    dto.maxBuild >= release.build ||
    dto.forceBelow > release.build ||
    new Date(dto.startsAt) >= new Date(dto.endsAt)
  )
    throw new BadRequestException('更新范围、时间窗口或强制更新阈值无效');
}
export function decideUpdate(
  plans: Array<ConsoleReleasePlan & { release: ConsoleRelease }>,
  input: { build: number; installation: string },
  now = new Date(),
) {
  const ordered = [...plans].sort(
    (a, b) =>
      b.release.build - a.release.build ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );
  const plan = ordered.find(
    (p) =>
      p.enabled &&
      !p.release.withdrawnAt &&
      p.startsAt <= now &&
      p.endsAt > now &&
      input.build >= p.minBuild &&
      input.build <= p.maxBuild &&
      input.build < p.release.build &&
      stableRollout(input.installation, p.releaseID) < p.rollout,
  );
  if (!plan) return { update: null, mandatory: false };
  const r = plan.release;
  return {
    update: {
      schemaVersion: 1,
      version: r.version,
      versionCode: r.build,
      apkUrl: r.url,
      sha256: r.sha256,
      sizeBytes: r.sizeBytes,
      notes: r.notes,
      platform: r.platform,
    },
    mandatory: input.build < plan.forceBelow,
  };
}
export function diagnosticCategory(value: string | null): string | null {
  if (!value) return null;
  const fixed = [
    'DeviceNotRegistered',
    'MessageTooBig',
    'MessageRateExceeded',
    'InvalidCredentials',
    'token-revoked',
    'expired',
    'recipient-unavailable',
  ];
  return fixed.includes(value) ? value : 'PROCESSING_ERROR';
}
