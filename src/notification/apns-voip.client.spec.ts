import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  createServer,
  type Http2Server,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import {
  ApnsVoipClient,
  classifyApnsResponse,
  Http2ApnsTransport,
  type ApnsRequest,
  type ApnsResponse,
  type ApnsTransport,
} from './apns-voip.client';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN = 'ab'.repeat(32);

function configWith(values: Record<string, string | undefined>) {
  return new ConfigService(values);
}

class RecordingTransport implements ApnsTransport {
  requests: ApnsRequest[] = [];
  response: ApnsResponse | Error = { status: 200 };
  closed = false;

  send(request: ApnsRequest): Promise<ApnsResponse> {
    this.requests.push(request);
    return this.response instanceof Error
      ? Promise.reject(this.response)
      : Promise.resolve(this.response);
  }

  close(): void {
    this.closed = true;
  }
}

function configuredClient(transport: ApnsTransport, extra = {}) {
  return new ApnsVoipClient(
    configWith({
      APNS_KEY_ID: 'KEY123',
      APNS_TEAM_ID: 'TEAM456',
      // 同 .env：PEM 里的换行常被写成 \n 转义。
      APNS_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
      ...extra,
    }),
    transport,
  );
}

describe('ApnsVoipClient', () => {
  const expiresAt = new Date('2026-10-26T12:00:45.000Z');

  afterEach(() => jest.restoreAllMocks());

  it('sends a VoIP push with the headers PushKit requires', async () => {
    const transport = new RecordingTransport();
    const client = configuredClient(transport);

    const outcome = await client.send({
      token: TOKEN,
      environment: 'development',
      payload: { call: { callId: 'c1' } },
      expiresAt,
    });

    expect(outcome).toEqual({
      token: TOKEN,
      status: 'SENT',
      receiptFinal: true,
    });
    expect(transport.requests).toHaveLength(1);
    const [request] = transport.requests;
    expect(request.environment).toBe('development');
    expect(request.token).toBe(TOKEN);
    expect(request.headers).toMatchObject({
      'apns-push-type': 'voip',
      'apns-topic': 'com.yiboding.circleim.voip',
      'apns-priority': '10',
      'apns-expiration': String(expiresAt.getTime() / 1000),
    });
    expect(JSON.parse(request.body)).toEqual({ call: { callId: 'c1' } });
  });

  it('signs an ES256 provider token Apple can verify, and reuses it', async () => {
    const transport = new RecordingTransport();
    const client = configuredClient(transport, { APNS_VOIP_TOPIC: 'x.y.voip' });

    await client.send({
      token: TOKEN,
      environment: 'production',
      payload: {},
      expiresAt,
    });
    await client.send({
      token: TOKEN,
      environment: 'production',
      payload: {},
      expiresAt,
    });

    const [first, second] = transport.requests.map(
      (r) => r.headers.authorization,
    );
    expect(first).toBe(second);
    expect(transport.requests[0].headers['apns-topic']).toBe('x.y.voip');
    const jwt = first.replace(/^bearer /, '');
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
    });
    expect(
      JSON.parse(Buffer.from(claims, 'base64url').toString()),
    ).toMatchObject({
      iss: 'TEAM456',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('mints a fresh provider token after 50 minutes', async () => {
    const transport = new RecordingTransport();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const client = configuredClient(transport);

    await client.send({
      token: TOKEN,
      environment: 'production',
      payload: {},
      expiresAt,
    });
    now.mockReturnValue(1_000_000 + 51 * 60 * 1000);
    await client.send({
      token: TOKEN,
      environment: 'production',
      payload: {},
      expiresAt,
    });

    const [first, second] = transport.requests.map(
      (r) => r.headers.authorization,
    );
    expect(first).not.toBe(second);
  });

  it('drops a cached provider token Apple says has expired', async () => {
    const transport = new RecordingTransport();
    const client = configuredClient(transport);
    const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);

    transport.response = { status: 403, reason: 'ExpiredProviderToken' };
    const expired = await client.send({
      token: TOKEN,
      environment: 'production',
      payload: {},
      expiresAt,
    });
    now.mockReturnValue(2_000_000 + 1000);
    transport.response = { status: 200 };
    await client.send({
      token: TOKEN,
      environment: 'production',
      payload: {},
      expiresAt,
    });

    expect(expired.status).toBe('RETRYABLE');
    const [first, second] = transport.requests.map(
      (r) => r.headers.authorization,
    );
    expect(first).not.toBe(second);
  });

  it('skips sending when credentials are missing', async () => {
    const transport = new RecordingTransport();
    const client = new ApnsVoipClient(configWith({}), transport);

    expect(client.isConfigured()).toBe(false);
    await expect(
      client.send({
        token: TOKEN,
        environment: 'production',
        payload: {},
        expiresAt,
      }),
    ).resolves.toEqual({
      token: TOKEN,
      status: 'RETRYABLE',
      error: 'ApnsNotConfigured',
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('treats an unparsable key as not configured instead of crashing boot', () => {
    const client = new ApnsVoipClient(
      configWith({
        APNS_KEY_ID: 'KEY123',
        APNS_TEAM_ID: 'TEAM456',
        APNS_PRIVATE_KEY: 'not-a-key',
      }),
      new RecordingTransport(),
    );

    expect(client.isConfigured()).toBe(false);
  });

  it('accepts a base64-encoded .p8', () => {
    const client = new ApnsVoipClient(
      configWith({
        APNS_KEY_ID: 'KEY123',
        APNS_TEAM_ID: 'TEAM456',
        APNS_PRIVATE_KEY: Buffer.from(PEM).toString('base64'),
      }),
      new RecordingTransport(),
    );

    expect(client.isConfigured()).toBe(true);
  });

  it('reports transport failures as retryable, never throws', async () => {
    const transport = new RecordingTransport();
    transport.response = new Error('socket hang up');
    const client = configuredClient(transport);

    await expect(
      client.send({
        token: TOKEN,
        environment: 'production',
        payload: {},
        expiresAt,
      }),
    ).resolves.toEqual({
      token: TOKEN,
      status: 'RETRYABLE',
      error: 'socket hang up',
    });
  });

  it('closes the transport on shutdown', () => {
    const transport = new RecordingTransport();
    configuredClient(transport).onModuleDestroy();
    expect(transport.closed).toBe(true);
  });
});

describe('classifyApnsResponse', () => {
  it.each([
    [{ status: 410, reason: 'Unregistered' }, 'TERMINAL', 'ApnsUnregistered'],
    [{ status: 410 }, 'TERMINAL', 'ApnsUnregistered'],
    [
      { status: 400, reason: 'BadDeviceToken' },
      'TERMINAL',
      'ApnsBadDeviceToken',
    ],
    // 配错 topic 是我们的问题，不能拿它当死令牌把设备停掉。
    [
      { status: 400, reason: 'DeviceTokenNotForTopic' },
      'TERMINAL',
      'ApnsError:DeviceTokenNotForTopic',
    ],
    [
      { status: 429, reason: 'TooManyRequests' },
      'RETRYABLE',
      'ApnsError:TooManyRequests',
    ],
    [{ status: 503 }, 'RETRYABLE', 'ApnsError:503'],
    [
      { status: 403, reason: 'ExpiredProviderToken' },
      'RETRYABLE',
      'ApnsError:ExpiredProviderToken',
    ],
    [
      { status: 403, reason: 'InvalidProviderToken' },
      'TERMINAL',
      'ApnsError:InvalidProviderToken',
    ],
  ] as const)('%p → %s %s', (response, status, error) => {
    expect(classifyApnsResponse(TOKEN, response)).toEqual({
      token: TOKEN,
      status,
      error,
    });
  });
});

describe('Http2ApnsTransport', () => {
  let server: Http2Server;
  let origin: string;
  let seen: Array<{ headers: Record<string, unknown>; body: string }>;
  let reply: { status: number; body?: string };

  beforeEach(async () => {
    seen = [];
    reply = { status: 200 };
    server = createServer();
    server.on('stream', (stream: ServerHttp2Stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => (body += chunk));
      stream.on('end', () => {
        seen.push({ headers, body });
        stream.respond({ ':status': reply.status });
        stream.end(reply.body ?? '');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts to /3/device/<token> over HTTP/2 and reads the APNs reason', async () => {
    const transport = new Http2ApnsTransport({
      production: origin,
      development: origin,
    });
    reply = { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) };

    const response = await transport.send({
      environment: 'production',
      token: TOKEN,
      headers: { 'apns-push-type': 'voip' },
      body: '{"call":{}}',
    });
    transport.close();

    expect(response).toEqual({ status: 400, reason: 'BadDeviceToken' });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(seen[0].headers[':method']).toBe('POST');
    expect(seen[0].headers['apns-push-type']).toBe('voip');
    expect(seen[0].body).toBe('{"call":{}}');
  });

  it('reuses one session per environment', async () => {
    const sessions = new Set<unknown>();
    server.on('session', (session) => sessions.add(session));
    const transport = new Http2ApnsTransport({
      production: origin,
      development: origin,
    });

    for (let i = 0; i < 3; i += 1) {
      await transport.send({
        environment: 'production',
        token: TOKEN,
        headers: {},
        body: '{}',
      });
    }
    transport.close();

    expect(seen).toHaveLength(3);
    expect(sessions.size).toBe(1);
  });
});
