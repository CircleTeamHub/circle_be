import { buildNestFactoryOptions, resolveAppPort } from './main';

describe('resolveAppPort', () => {
  it('rejects malformed port strings', () => {
    expect(() => resolveAppPort('3000{')).toThrow('Invalid APP_PORT value');
  });

  it('accepts numeric strings', () => {
    expect(resolveAppPort('3000')).toBe(3000);
  });
});

describe('buildNestFactoryOptions', () => {
  it('enables raw body support for signed webhooks', () => {
    expect(buildNestFactoryOptions().rawBody).toBe(true);
  });
});
