import { isUUID } from 'class-validator';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deterministicUuid } = require('../../scripts/deterministic-id.cjs') as {
  deterministicUuid: (namespace: string, key: string) => string;
};

describe('deterministic script ids', () => {
  it('generates stable RFC UUIDs from seed keys', () => {
    const id = deterministicUuid('circle-seed:', 'circle:shanghai');

    expect(id).toBe('07b8cd30-afdf-5b74-9dfe-6dd5b422364b');
    expect(isUUID(id, 'all')).toBe(true);
  });
});
