const fs = require('node:fs');
const { once } = require('node:events');
const zlib = require('node:zlib');

const output = process.argv[2];
const sizes = process.argv.slice(3).map(Number);
if (!output || sizes.length === 0 || sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) {
  throw new Error('usage: node create-sized-tar.cjs OUTPUT SIZE...');
}

function writeOctal(header, offset, length, value) {
  header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

function headerFor(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

async function write(gzip, chunk) {
  if (!gzip.write(chunk)) await once(gzip, 'drain');
}

(async () => {
  const gzip = zlib.createGzip({ level: 1 });
  gzip.pipe(fs.createWriteStream(output));
  const zeros = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index];
    await write(gzip, headerFor(`file-${index}`, size));
    let remaining = Math.ceil(size / 512) * 512;
    while (remaining > 0) {
      const bytes = Math.min(remaining, zeros.length);
      await write(gzip, zeros.subarray(0, bytes));
      remaining -= bytes;
    }
  }
  await write(gzip, Buffer.alloc(1024));
  gzip.end();
  await once(gzip, 'end');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
