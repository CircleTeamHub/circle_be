import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
} from 'node:crypto';
import {
  createWebPushSender,
  encryptWebPush,
  parseWebPushToken,
} from './web-push';

const endpoint = 'https://fcm.googleapis.com/fcm/send/fixture';

function browserFixture() {
  const receiver = createECDH('prime256v1');
  const publicPoint = receiver.generateKeys();
  const auth = randomBytes(16);
  return {
    receiver,
    publicPoint,
    auth,
    userKey: publicPoint.toString('base64url'),
    authKey: auth.toString('base64url'),
  };
}

describe('Web Push', () => {
  it('lets a browser decrypt a final record per RFC 8291', () => {
    const { receiver, publicPoint, auth, userKey, authKey } = browserFixture();
    const subscription = parseWebPushToken(
      JSON.stringify([endpoint, userKey, authKey]),
    )!;
    const message = Buffer.from('Synthetic notification');
    const record = encryptWebPush(subscription, message);
    const salt = record.subarray(0, 16);
    expect(record.readUInt32BE(16)).toBe(4096);
    expect(record[20]).toBe(65);
    const senderPoint = record.subarray(21, 86);
    const sharedSecret = receiver.computeSecret(senderPoint);

    const authPrk = createHmac('sha256', auth).update(sharedSecret).digest();
    const inputKey = createHmac('sha256', authPrk)
      .update('WebPush: info\x00')
      .update(publicPoint)
      .update(senderPoint)
      .update(Buffer.of(1))
      .digest();
    const prk = createHmac('sha256', salt).update(inputKey).digest();
    const key = createHmac('sha256', prk)
      .update('Content-Encoding: aes128gcm\x00\x01')
      .digest()
      .subarray(0, 16);
    const nonce = createHmac('sha256', prk)
      .update('Content-Encoding: nonce\x00\x01')
      .digest()
      .subarray(0, 12);

    const decipher = createDecipheriv('aes-128-gcm', key, nonce, {
      authTagLength: 16,
    });
    decipher.setAuthTag(record.subarray(-16));
    expect(
      Buffer.concat([
        decipher.update(record.subarray(86, -16)),
        decipher.final(),
      ]),
    ).toEqual(Buffer.concat([message, Buffer.of(2)]));
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/fixture',
    'https://fcm.googleapis.com/wp/fixture',
    'https://jmt17.google.com/fcm/send/fixture',
    'https://jmt17.google.com/wp/fixture',
    'https://web.push.apple.com/fixture',
    'https://updates.push.services.mozilla.com/wpush/v2/fixture',
    'https://wns2-par02p.notify.windows.com/w/?token=fixture',
  ])('accepts the browser push service endpoint %s', (url) => {
    const { userKey, authKey } = browserFixture();
    expect(
      parseWebPushToken(JSON.stringify([url, userKey, authKey]))?.endpoint,
    ).toBe(url);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/fixture',
    'https://localhost/push',
    'https://fcm.googleapis.com.other.test/fcm/send/fixture',
    'https://fcm.googleapis.com:3443/fcm/send/fixture',
    'https://fcm.googleapis.com/other/fixture',
    'https://jmt17.google.com/other/fixture',
    'https://web.push.apple.com@other.test/push',
    'https://web.push.apple.com/',
    'https://updates.push.services.mozilla.com/other/fixture',
    'https://notify.windows.com/w/?token=fixture',
    'https://notify.windows.com.evil.test/w/?token=fixture',
    'https://evilnotify.windows.com/w/?token=fixture',
    'https://.notify.windows.com/w/?token=fixture',
    'https://wns2-par02p.notify.windows.com/other?token=fixture',
  ])('rejects unsupported subscription endpoint %s', (url) => {
    const { userKey, authKey } = browserFixture();
    expect(
      parseWebPushToken(JSON.stringify([url, userKey, authKey])),
    ).toBeNull();
  });

  it('rejects an off-curve public key', () => {
    const { authKey } = browserFixture();
    const invalid = Buffer.alloc(65);
    invalid[0] = 4;
    expect(
      parseWebPushToken(
        JSON.stringify([endpoint, invalid.toString('base64url'), authKey]),
      ),
    ).toBeNull();
  });

  it('authenticates the provider request with a signed VAPID token and no redirects', async () => {
    const { userKey, authKey } = browserFixture();
    const subscription = parseWebPushToken(
      JSON.stringify([endpoint, userKey, authKey]),
    )!;
    const signer = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKey = signer.privateKey.export({ format: 'jwk' }).d;
    const sender = createWebPushSender(privateKey, 'mailto:push@example.com')!;
    const fetch = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    try {
      await expect(
        sender.send(subscription, '{"type":"chat"}', 60),
      ).resolves.toBe(201);
      const [url, request] = fetch.mock.calls[0];
      expect(url).toBe(endpoint);
      expect(request).toMatchObject({
        method: 'POST',
        redirect: 'error',
        headers: {
          TTL: '60',
          'Content-Encoding': 'aes128gcm',
          Urgency: 'high',
        },
      });
      const authorization = new Headers(request?.headers).get('authorization')!;
      const [jwt, publicKey] = authorization
        .replace(/^vapid t=/, '')
        .split(', k=');
      const [header, claims, signature] = jwt.split('.');
      expect(
        JSON.parse(Buffer.from(claims, 'base64url').toString()),
      ).toMatchObject({
        aud: 'https://fcm.googleapis.com',
        sub: 'mailto:push@example.com',
      });
      const point = Buffer.from(publicKey, 'base64url');
      const key = createPublicKey({
        format: 'jwk',
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: point.subarray(1, 33).toString('base64url'),
          y: point.subarray(33).toString('base64url'),
        },
      });
      expect(
        verify(
          'sha256',
          Buffer.from(header + '.' + claims),
          { key, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });
});
