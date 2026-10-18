import assert from 'node:assert/strict';
import test from 'node:test';
import { exposureIssues } from './check-gateway-exposure.mjs';

test('only approved ingress and loopback management ports are published', () => {
  assert.deepEqual(
    exposureIssues({
      services: {
        caddy: {
          ports: [
            { target: 80, published: '80' },
            { target: 443, published: '443' },
          ],
        },
        api: { expose: ['3000'] },
        minio: {
          ports: [{ host_ip: '127.0.0.1', target: 9001, published: '9001' }],
        },
        redis: {},
        postgres: {},
      },
    }),
    [],
  );
});
test('rejects direct API/database/IPv6 exposure and host networking', () => {
  for (const name of ['circle_be', 'circle_be_green', 'postgres', 'redis']) {
    assert.equal(
      exposureIssues({
        services: {
          [name]: {
            ports: [{ host_ip: '::', published: '3000', target: 3000 }],
          },
        },
      }).length,
      1,
    );
  }
  assert.equal(
    exposureIssues({ services: { api: { network_mode: 'host' } } }).length,
    1,
  );
  assert.equal(exposureIssues({ services: {} }).length, 1);
});
