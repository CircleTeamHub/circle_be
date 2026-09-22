import {
  safeLogPath,
  sanitizeLogText,
  sanitizeLogValue,
} from './log-sanitizer';

describe('log sanitizer', () => {
  it('recursively redacts private fields without mutating the original', () => {
    const source = {
      event: 'business_event',
      actorId: 'user-1',
      metadata: {
        nested: [
          { Access_Token: 'private-token', email: 'private@example.com' },
        ],
        body: { count: 12 },
        payload: { message: 'private chat' },
        deviceId: 'private-device',
        ip: '127.0.0.1',
        passwordHash: 'private-hash',
        elapsedMs: 42,
      },
    };

    const result = sanitizeLogValue(source);
    expect(result).toMatchObject({
      event: 'business_event',
      actorId: 'user-1',
      metadata: {
        nested: [{ Access_Token: '[redacted]', email: '[redacted]' }],
        body: '[redacted]',
        payload: '[redacted]',
        deviceId: '[redacted]',
        ip: '[redacted]',
        passwordHash: '[redacted]',
        elapsedMs: 42,
      },
    });
    expect(source.metadata.nested[0].Access_Token).toBe('private-token');
    expect(source.metadata.body).toEqual({ count: 12 });
  });

  it('redacts credentials and signed URLs embedded in text', () => {
    const value = sanitizeLogText(
      'failed Authorization: Bearer private-bearer password="two private words" ' +
        'private@example.com eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature ' +
        'https://files.example.com/private.jpg?X-Amz-Signature=private-signature',
    );
    for (const privateValue of [
      'private-bearer',
      'two private words',
      'private@example.com',
      'eyJhbGci',
      'private.jpg',
      'private-signature',
    ]) {
      expect(value).not.toContain(privateValue);
    }
    expect(value).toContain('failed');
  });

  it('uses known route templates and buckets all unmatched paths', () => {
    expect(
      safeLogPath('/api/v1/note/share-links/private-link?code=secret'),
    ).toBe('/api/v1/note/share-links/:token');
    expect(safeLogPath('/API/V1/TEMP-CHAT/by-token/private-link/join')).toBe(
      '/api/v1/temp-chat/by-token/:token/join',
    );
    expect(safeLogPath('/api/v1/unknown/private-link')).toBe('/__other__');
    expect(
      safeLogPath('/api/v1/chat/conversations/private-conversation/events'),
    ).toBe('/api/v1/chat/conversations/:id/events');
    expect(safeLogPath('/api/v1/note/private-note/exports')).toBe(
      '/api/v1/note/:id/exports',
    );
    expect(safeLogPath('/api/v1/notification/profile/list')).toBe(
      '/api/v1/notification/profile/list',
    );
    expect(
      sanitizeLogText('POST /api/v1/temp-chat/by-token/private-link/join'),
    ).not.toContain('private-link');
    expect(
      sanitizeLogValue({
        path: '/anything/private',
        originalUrl: '/api/v1/auth/login?password=secret',
      }),
    ).toEqual({ path: '/__other__', originalUrl: '/api/v1/auth/login' });
  });

  it('keeps exception type and call sites without SQL, messages or causes', () => {
    const error = new TypeError('SELECT private_content FROM messages');
    error.stack =
      'TypeError: SELECT private_content FROM messages\n    at execute (C:\\app\\src\\repository.ts:42:9)\n    at /app/src/main.ts:5:3\nprivate_content';
    Object.assign(error, {
      cause: new Error('private-cause'),
      query: 'private-sql',
    });
    const result = sanitizeLogValue(error);
    expect(result).toMatchObject({
      name: 'TypeError',
      message: '[redacted]',
      stack: expect.stringContaining('repository.ts:42:9'),
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private_|private-cause|private-sql|SELECT/,
    );
  });

  it('bounds cycles, depth, strings and breadth and never invokes accessors', () => {
    const getter = jest.fn(() => {
      throw new Error('getter must not run');
    });
    const source: Record<string, unknown> = {
      long: 'a'.repeat(10000),
      children: Array.from({ length: 1000 }, (_, i) => ({ count: i })),
    };
    source.self = source;
    Object.defineProperty(source, 'computed', {
      enumerable: true,
      get: getter,
    });
    source.deep = { a: { b: { c: { d: { e: { f: 'private-deep' } } } } } };
    const result = sanitizeLogValue(source);
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain('[circular]');
    expect(JSON.stringify(result)).not.toContain('private-deep');
    expect(JSON.stringify(result).length).toBeLessThan(10000);
    expect(() =>
      sanitizeLogValue(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('private-proxy');
            },
          },
        ),
      ),
    ).not.toThrow();
  });

  it('does not serialize arbitrary toJSON hooks or binary content', () => {
    const toJSON = jest.fn(() => 'private-hook');
    const result = sanitizeLogValue({
      value: { toJSON, count: 1 },
      buffer: Buffer.from('private-buffer'),
    });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('suppresses string errors and unknown path tokens embedded in prose', () => {
    const result = sanitizeLogValue({
      error: 'SELECT private_text FROM chats',
      pathMessage: 'GET /api/v1/unlisted/private-path?key=secret',
      phoneHint: 'phone=+15551234567',
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private_|private-path|15551234567/,
    );
  });

  it('does not invoke a custom exception stack getter', () => {
    const getter = jest.fn(() => {
      throw new Error('private-getter');
    });
    const error = new Error('private-message');
    Object.defineProperty(error, 'stack', { get: getter });
    expect(() => sanitizeLogValue(error)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('does not invoke stack-array accessors or error-name getters indirectly', () => {
    const getter = jest.fn(() => 'private-getter');
    const stack: unknown[] = [];
    Object.defineProperty(stack, '0', { get: getter });
    const error = new Error('private-error');
    Object.defineProperty(error, 'name', { get: getter });
    sanitizeLogValue({ stack, error });
    expect(getter).not.toHaveBeenCalled();
  });

  it('keeps sanitized stack sites on subsequent sanitization', () => {
    const once = sanitizeLogValue({ error: new TypeError('private-message') });
    const twice = sanitizeLogValue(once);
    expect(twice).toMatchObject({
      error: { stack: expect.stringContaining('log-sanitizer.spec.ts:') },
    });
  });

  it('redacts private relative object keys in existing media failure warnings', () => {
    const result = sanitizeLogText(
      'chat media delete failed key=chat/room-123/private-file.jpg: AccessDenied objectKey=uploads/private-file.jpg',
    );
    expect(result).not.toContain('private-file');
    expect(result).not.toContain('room-123');
    expect(result).toContain('AccessDenied');
  });

  it('keeps truncated quoted credentials private', () => {
    expect(
      sanitizeLogText(`password="${'private words '.repeat(300)}"`),
    ).not.toContain('private');
  });
});
