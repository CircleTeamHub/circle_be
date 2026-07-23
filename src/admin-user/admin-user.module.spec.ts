import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdminUserModule } from './admin-user.module';
import { SessionRevocationOutboxProcessor } from './session-revocation-outbox.processor';

describe('AdminUserModule wiring', () => {
  it('registers the durable session revocation processor', () => {
    const providers =
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AdminUserModule) ?? [];

    expect(providers).toContain(SessionRevocationOutboxProcessor);
  });
});
