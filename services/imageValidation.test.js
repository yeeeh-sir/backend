const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectImageFormat,
  readImageDimensions,
  validateImageBuffer,
  validatePostImageFiles,
} = require('./imageValidation');

function makePng(width, height, size = 64) {
  const buffer = Buffer.alloc(Math.max(size, 24));
  buffer[0] = 0x89;
  buffer[1] = 0x50;
  buffer[2] = 0x4e;
  buffer[3] = 0x47;
  buffer[4] = 0x0d;
  buffer[5] = 0x0a;
  buffer[6] = 0x1a;
  buffer[7] = 0x0a;
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function makeJpeg(width, height) {
  const buffer = Buffer.alloc(24);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 0x08;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

function makeWebp(width, height) {
  const buffer = Buffer.alloc(30);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer[24] = (width - 1) & 0xff;
  buffer[25] = ((width - 1) >> 8) & 0xff;
  buffer[26] = ((width - 1) >> 16) & 0xff;
  buffer[27] = (height - 1) & 0xff;
  buffer[28] = ((height - 1) >> 8) & 0xff;
  buffer[29] = ((height - 1) >> 16) & 0xff;
  return buffer;
}

test('detects supported image formats from content', () => {
  assert.equal(detectImageFormat(makePng(1200, 630)), 'png');
  assert.equal(detectImageFormat(makeJpeg(1200, 630)), 'jpeg');
  assert.equal(detectImageFormat(makeWebp(1200, 630)), 'webp');
  assert.equal(detectImageFormat(Buffer.from('not an image here')), null);
});

test('reads dimensions from each supported format', () => {
  assert.deepEqual(readImageDimensions(makePng(1200, 630), 'png'), {
    width: 1200,
    height: 630,
  });
  assert.deepEqual(readImageDimensions(makeJpeg(1200, 630), 'jpeg'), {
    width: 1200,
    height: 630,
  });
  assert.deepEqual(readImageDimensions(makeWebp(1200, 630), 'webp'), {
    width: 1200,
    height: 630,
  });
});

test('accepts supported images within the size limit', () => {
  assert.equal(validateImageBuffer(makePng(800, 600)), null);
  assert.equal(validateImageBuffer(makeJpeg(1200, 630)), null);
  assert.equal(validateImageBuffer(makeWebp(640, 360)), null);
});

test('rejects images larger than 120 KB', () => {
  const error = validateImageBuffer(makePng(800, 600, 130 * 1024));
  assert.match(error, /120 KB/);
});

test('rejects unsupported or invalid image content', () => {
  assert.ok(validateImageBuffer(Buffer.from('GIF89a.....')));
  assert.ok(validateImageBuffer(Buffer.alloc(0)));
});

test('rejects more than two images per post', () => {
  const files = [
    { buffer: makePng(1200, 630) },
    { buffer: makePng(1200, 630) },
    { buffer: makePng(1200, 630) },
  ];

  assert.match(validatePostImageFiles(files), /at most 2 images/);
});

test('accepts a valid pair of images', () => {
  const files = [
    { buffer: makePng(1200, 630) },
    { buffer: makeJpeg(1200, 630) },
  ];

  assert.equal(validatePostImageFiles(files), null);
});
