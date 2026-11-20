import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  ECDH,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

export const MAX_WEB_PUSH_TOKEN_LENGTH = 2048;
const keyPattern = /^[A-Za-z0-9_-]+$/;

export type WebPushSubscription = {
  endpoint: string;
  publicKey: Buffer;
  authSecret: Buffer;
};

function decodeKey(value: unknown, length: number): Buffer | null {
  if (typeof value !== 'string' || !keyPattern.test(value)) return null;
  const key = Buffer.from(value, 'base64url');
  return key.length === length && key.toString('base64url') === value
    ? key
    : null;
}

// The browsers' push services and the paths their subscription endpoints use.
// Chrome Beta/Dev/Canary subscribe through jmt17.google.com; Windows (Edge)
// issues regional hosts such as wns2-par02p.notify.windows.com.
function isPushServiceEndpoint({ hostname, pathname }: URL): boolean {
  if (hostname === 'fcm.googleapis.com' || hostname === 'jmt17.google.com')
    return pathname.startsWith('/fcm/send/') || pathname.startsWith('/wp/');
  if (hostname === 'updates.push.services.mozilla.com')
    return pathname.startsWith('/wpush/');
  if (/^[a-z0-9-]+\.notify\.windows\.com$/.test(hostname))
    return pathname.startsWith('/w/');
  return hostname === 'web.push.apple.com' && pathname !== '/';
}

// The token is a canonical tuple of browser-provided subscription values.
export function parseWebPushToken(token: string): WebPushSubscription | null {
  if (token.length > MAX_WEB_PUSH_TOKEN_LENGTH) return null;
  try {
    const tuple: unknown = JSON.parse(token);
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 3 ||
      typeof tuple[0] !== 'string'
    )
      return null;
    const [endpoint, p256dh, auth] = tuple;
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !isPushServiceEndpoint(url) ||
      endpoint !== url.href
    )
      return null;
    const publicKey = decodeKey(p256dh, 65);
    const authSecret = decodeKey(auth, 16);
    if (publicKey?.[0] !== 4 || !authSecret || JSON.stringify(tuple) !== token)
      return null;
    // Reject invalid points at registration, before they reach the send queue.
    ECDH.convertKey(publicKey, 'prime256v1');
    return { endpoint, publicKey, authSecret };
  } catch {
    return null;
  }
}

export function createWebPushSender(
  privateKey: string | undefined,
  subject: string,
) {
  const secret = decodeKey(privateKey?.trim(), 32);
  if (!secret) return null;
  const keyPair = createECDH('prime256v1');
  try {
    keyPair.setPrivateKey(secret);
  } catch {
    return null;
  }
  const publicKey = keyPair.getPublicKey();
  const encodedKey = publicKey.toString('base64url');
  const signingKey = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: secret.toString('base64url'),
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33).toString('base64url'),
    },
  });

  return {
    publicKey: encodedKey,
    async send(
      subscription: WebPushSubscription,
      payload: string,
      ttl: number,
    ) {
      // RFC 8292. The audience is the push provider, never the application origin.
      const header = Buffer.from('{"typ":"JWT","alg":"ES256"}').toString(
        'base64url',
      );
      const claims = Buffer.from(
        JSON.stringify({
          aud: new URL(subscription.endpoint).origin,
          exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
          sub: subject,
        }),
      ).toString('base64url');
      const unsigned = header + '.' + claims;
      const signature = sign('sha256', Buffer.from(unsigned), {
        key: signingKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url');
      const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
          Authorization:
            'vapid t=' + unsigned + '.' + signature + ', k=' + encodedKey,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(ttl),
          // RFC 8030 defaults to normal, which a dozing phone holds until it wakes.
          Urgency: 'high',
        },
        body: new Uint8Array(
          encryptWebPush(subscription, Buffer.from(payload)),
        ),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      void response.body?.cancel().catch(() => undefined);
      return response.status;
    },
  };
}

// RFC 8291 and RFC 8188. A Web Push payload is encrypted as one final record.
export function encryptWebPush(
  subscription: Pick<WebPushSubscription, 'publicKey' | 'authSecret'>,
  message: Buffer,
  salt = randomBytes(16),
  senderKey?: ReturnType<typeof createECDH>,
): Buffer {
  const sender = senderKey ?? createECDH('prime256v1');
  const senderPublicKey = senderKey
    ? sender.getPublicKey()
    : sender.generateKeys();
  const sharedSecret = sender.computeSecret(subscription.publicKey);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    subscription.publicKey,
    senderPublicKey,
  ]);
  const inputKey = Buffer.from(
    hkdfSync('sha256', sharedSecret, subscription.authSecret, keyInfo, 32),
  );
  const key = Buffer.from(
    hkdfSync('sha256', inputKey, salt, 'Content-Encoding: aes128gcm\0', 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', inputKey, salt, 'Content-Encoding: nonce\0', 12),
  );

  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = senderPublicKey.length;
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  return Buffer.concat([
    header,
    senderPublicKey,
    cipher.update(message),
    cipher.update(Buffer.from([2])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
