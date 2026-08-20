const fs = require('node:fs');
const zlib = require('node:zlib');

const output = process.argv[2];
const count = Number(process.argv[3]);
const entryType = process.argv[4] ?? 'file';
if (!output || !Number.isSafeInteger(count) || count < 1 || !['file', 'link'].includes(entryType)) {
  throw new Error('usage: node create-many-entry-tar.cjs OUTPUT COUNT [file|link]');
}

function writeOctal(header, offset, length, value) {
  header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

function headerFor(name) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(entryType === 'link' ? '2' : '0', 156, 1, 'ascii');
  if (entryType === 'link') header.write('target', 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

const chunks = Array.from({ length: count }, (_, index) =>
  headerFor(`many/${index.toString().padStart(5, '0')}`),
);
chunks.push(Buffer.alloc(1024));
fs.writeFileSync(output, zlib.gzipSync(Buffer.concat(chunks)));
