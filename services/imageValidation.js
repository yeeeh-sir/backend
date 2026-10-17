const POST_IMAGE_MAX_BYTES = 120 * 1024;
const POST_MAX_IMAGES = 2;

const ALLOWED_IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp']);

const FORMAT_LABELS = {
  jpeg: 'JPEG',
  png: 'PNG',
  webp: 'WebP',
};

const FORMAT_MESSAGE =
  'Only JPEG, JPG, PNG, and WebP images are allowed.';
const COMPRESS_IMAGE_URL = 'https://imresizer.com/resize-image-to-120kb';
const SIZE_MESSAGE =
  `Each image must be ${Math.round(POST_IMAGE_MAX_BYTES / 1024)} KB or smaller. Compress your image here: ${COMPRESS_IMAGE_URL}`;
const COUNT_MESSAGE =
  `You can upload at most ${POST_MAX_IMAGES} images per post.`;

function detectImageFormat(buffer) {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  if (
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpeg';
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'png';
  }

  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }

  return null;
}

function readJpegDimensions(buffer) {
  const length = buffer.length;
  let offset = 2;

  while (offset + 9 <= length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let marker = buffer[offset + 1];

    while (marker === 0xff && offset + 2 < length) {
      offset += 1;
      marker = buffer[offset + 1];
    }

    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    if (marker >= 0xd0 && marker <= 0xd7) {
      offset += 2;
      continue;
    }

    if (marker === 0x01) {
      offset += 2;
      continue;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);

    if (segmentLength < 2) {
      return null;
    }

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isStartOfFrame) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);

      return { width, height };
    }

    offset += 2 + segmentLength;
  }

  return null;
}

function readPngDimensions(buffer) {
  if (buffer.length < 24) {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function readWebpDimensions(buffer) {
  if (buffer.length < 20) {
    return null;
  }

  const chunk = buffer.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    if (buffer.length < 30) {
      return null;
    }

    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;

    return { width, height };
  }

  if (chunk === 'VP8L') {
    if (buffer.length < 25) {
      return null;
    }

    const bits =
      buffer[21] |
      (buffer[22] << 8) |
      (buffer[23] << 16) |
      (buffer[24] << 24);

    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;

    return { width, height };
  }

  if (chunk === 'VP8X') {
    if (buffer.length < 30) {
      return null;
    }

    const width =
      (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
    const height =
      (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;

    return { width, height };
  }

  return null;
}

function readImageDimensions(buffer, format) {
  switch (format) {
    case 'jpeg':
      return readJpegDimensions(buffer);
    case 'png':
      return readPngDimensions(buffer);
    case 'webp':
      return readWebpDimensions(buffer);
    default:
      return null;
  }
}

function validateImageBuffer(buffer) {
  if (!buffer || buffer.length === 0) {
    return 'No image file was uploaded.';
  }

  if (buffer.length > POST_IMAGE_MAX_BYTES) {
    return SIZE_MESSAGE;
  }

  const format = detectImageFormat(buffer);

  if (!format || !ALLOWED_IMAGE_FORMATS.has(format)) {
    return FORMAT_MESSAGE;
  }

  return null;
}

function validatePostImageFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];

  if (list.length > POST_MAX_IMAGES) {
    return COUNT_MESSAGE;
  }

  for (const file of list) {
    const error = validateImageBuffer(file.buffer);

    if (error) {
      return error;
    }
  }

  return null;
}

module.exports = {
  POST_IMAGE_MAX_BYTES,
  POST_MAX_IMAGES,
  ALLOWED_IMAGE_FORMATS,
  FORMAT_MESSAGE,
  COMPRESS_IMAGE_URL,
  SIZE_MESSAGE,
  COUNT_MESSAGE,
  detectImageFormat,
  readImageDimensions,
  validateImageBuffer,
  validatePostImageFiles,
};
