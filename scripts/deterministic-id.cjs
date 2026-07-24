'use strict';

const crypto = require('crypto');

function formatUuidFromHex(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function legacyDeterministicId(namespace, key) {
  const h = crypto
    .createHash('sha1')
    .update(namespace + key)
    .digest('hex');
  return formatUuidFromHex(h);
}

function deterministicUuid(namespace, key) {
  const bytes = crypto
    .createHash('sha1')
    .update(namespace + key)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return formatUuidFromHex(bytes.toString('hex'));
}

module.exports = {
  deterministicUuid,
  legacyDeterministicId,
};
