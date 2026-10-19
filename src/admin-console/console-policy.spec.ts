import {
  decideUpdate,
  stableRollout,
  validatePlan,
  validateRelease,
  diagnosticCategory,
} from './console-policy';
import { pageCursor, olderThan, paged } from './console-operations.service';
import type { ConsoleRelease, ConsoleReleasePlan } from 'src/generated/prisma';
const release = {
  id: 'release',
  platform: 'android',
  channel: 'stable',
  version: '1.2.3',
  build: 1002003,
  url: 'https://github.com/CircleTeamHub/windnote-releases/releases/download/v1.2.3/windnote.apk',
  sha256: 'a'.repeat(64),
  sizeBytes: 100,
  notes: '',
  withdrawnAt: null,
  createdAt: new Date(0),
} as ConsoleRelease;
const now = new Date('2026-10-17T00:00:00Z');
const plan = {
  id: 'plan',
  releaseID: 'release',
  rollout: 100,
  minBuild: 0,
  maxBuild: 1002002,
  forceBelow: 1001000,
  startsAt: new Date(0),
  endsAt: new Date('2099-01-01'),
  enabled: true,
  version: 1,
  createdAt: new Date(0),
  release,
} as ConsoleReleasePlan & { release: ConsoleRelease };
describe('release decisions', () => {
  it('keeps each installation in a stable bucket as rollout increases', () => {
    for (let index = 0; index < 200; index++) {
      const installation = `installation-${index}`;
      expect(stableRollout(installation, 'release')).toBe(
        stableRollout(installation, 'release'),
      );
      const low = decideUpdate(
        [{ ...plan, rollout: 10 }],
        { build: 1000000, installation },
        now,
      );
      const high = decideUpdate(
        [{ ...plan, rollout: 50 }],
        { build: 1000000, installation },
        now,
      );
      if (low.update) expect(high.update).not.toBeNull();
    }
  });
  it('never offers withdrawn, disabled, future, expired, or non-newer releases', () => {
    for (const p of [
      { ...plan, release: { ...release, withdrawnAt: now } },
      { ...plan, enabled: false },
      { ...plan, startsAt: new Date('2090-01-01') },
      { ...plan, endsAt: now },
      { ...plan, rollout: 0 },
    ])
      expect(
        decideUpdate([p], { build: 1000000, installation: 'a' }, now).update,
      ).toBeNull();
    expect(
      decideUpdate([plan], { build: release.build, installation: 'a' }, now)
        .update,
    ).toBeNull();
  });
  it('forces only eligible clients under the configured threshold', () => {
    expect(
      decideUpdate([plan], { build: 1000000, installation: 'a' }, now)
        .mandatory,
    ).toBe(true);
    expect(
      decideUpdate([plan], { build: 1001000, installation: 'a' }, now)
        .mandatory,
    ).toBe(false);
  });
  it('rejects unsafe install sources and invalid ranges', () => {
    const dto = { ...release, reason: 'test' };
    expect(() => validateRelease(dto)).not.toThrow();
    for (const url of [
      'http://github.com/a',
      'https://evil.example/a',
      dto.url + '?token=secret',
      'not a url',
    ])
      expect(() => validateRelease({ ...dto, url })).toThrow();
    expect(() => validateRelease({ ...dto, build: 1002004 })).toThrow();
    expect(() =>
      validatePlan(
        {
          ...plan,
          startsAt: plan.startsAt.toISOString(),
          endsAt: plan.endsAt.toISOString(),
          reason: 'test',
          maxBuild: release.build,
        },
        release,
      ),
    ).toThrow();
  });
});
describe('safe operator data', () => {
  it('replaces provider error text that might contain tokens or request bodies', () => {
    expect(diagnosticCategory('failed token=private message=secret')).toBe(
      'PROCESSING_ERROR',
    );
    expect(diagnosticCategory('DeviceNotRegistered')).toBe(
      'DeviceNotRegistered',
    );
  });
  it('validates keyset cursors and uses both timestamp and id on ties', () => {
    expect(() => pageCursor('bad')).toThrow();
    const id = '11111111-1111-4111-8111-111111111111',
      at = new Date('2026-10-17T00:00:00Z');
    const result = paged(
      [
        { id, createdAt: at },
        { id: '2', createdAt: at },
      ],
      1,
    );
    expect(pageCursor(result.nextCursor!)).toEqual({ createdAt: at, id });
    expect(olderThan(result.nextCursor!)).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }],
    });
  });
});
