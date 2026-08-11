import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ICON_SIZE = 1024;
const FAVICON_SIZE = 64;
const SPLASH_SIZE = 256;
const LOGICAL_GRID_SIZE = 64;
const OUTPUT_ROOT = resolve(import.meta.dirname, "../assets/icons");

const MARK_RECTS = [
  { height: 10, width: 20, x: 22, y: 17 },
  { height: 20, width: 10, x: 17, y: 22 },
  { height: 20, width: 10, x: 37, y: 22 },
  { height: 10, width: 20, x: 22, y: 37 },
];

const BADGE_RECTS = [
  { height: 4, width: 4, x: 47, y: 17 },
  { height: 4, width: 4, x: 47, y: 43 },
];

const COLORS = {
  black: [13, 16, 18, 255],
  cream: [242, 238, 234, 255],
  orange: [185, 108, 69, 255],
  transparent: [0, 0, 0, 0],
  white: [255, 255, 255, 255],
};

const VARIANTS = {
  development: {
    background: COLORS.cream,
    badgeColor: COLORS.black,
    badgeCount: 2,
    dark: {
      background: COLORS.black,
      badgeColor: COLORS.cream,
      mark: COLORS.orange,
    },
    light: {
      background: COLORS.cream,
      badgeColor: COLORS.black,
      mark: COLORS.orange,
    },
    mark: COLORS.orange,
  },
  preview: {
    background: COLORS.cream,
    badgeColor: COLORS.black,
    badgeCount: 1,
    dark: {
      background: COLORS.black,
      badgeColor: COLORS.cream,
      mark: COLORS.orange,
    },
    light: {
      background: COLORS.cream,
      badgeColor: COLORS.black,
      mark: COLORS.orange,
    },
    mark: COLORS.orange,
  },
  production: {
    background: COLORS.orange,
    badgeColor: COLORS.cream,
    badgeCount: 0,
    dark: {
      background: COLORS.black,
      badgeColor: COLORS.orange,
      mark: COLORS.orange,
    },
    light: {
      background: COLORS.orange,
      badgeColor: COLORS.cream,
      mark: COLORS.black,
    },
    mark: COLORS.black,
  },
};

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;

  const stride = image.width * 4;
  const scanlines = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const scanlineOffset = y * (stride + 1);
    scanlines[scanlineOffset] = 0;
    image.pixels.copy(
      scanlines,
      scanlineOffset + 1,
      y * stride,
      (y + 1) * stride
    );
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function createImage(width, height, color = COLORS.transparent) {
  const image = { height, pixels: Buffer.alloc(width * height * 4), width };
  drawRect(image, 0, 0, width, height, color);
  return image;
}

function drawRect(image, x, y, width, height, color) {
  for (const value of [x, y, width, height]) {
    if (!Number.isInteger(value)) {
      throw new Error(`Rectangle coordinate is off-grid: ${value}`);
    }
  }

  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(image.width, x + width);
  const bottom = Math.min(image.height, y + height);

  for (let row = top; row < bottom; row += 1) {
    for (let column = left; column < right; column += 1) {
      const offset = (row * image.width + column) * 4;
      image.pixels[offset] = color[0];
      image.pixels[offset + 1] = color[1];
      image.pixels[offset + 2] = color[2];
      image.pixels[offset + 3] = color[3];
    }
  }
}

function drawLegacyTile(image, color) {
  const rectangles = [
    { height: 56, width: 40, x: 12, y: 4 },
    { height: 52, width: 48, x: 8, y: 6 },
    { height: 48, width: 52, x: 6, y: 8 },
    { height: 40, width: 56, x: 4, y: 12 },
  ];
  const pixelSize = image.width / LOGICAL_GRID_SIZE;

  for (const { height, width, x, y } of rectangles) {
    drawRect(
      image,
      x * pixelSize,
      y * pixelSize,
      width * pixelSize,
      height * pixelSize,
      color
    );
  }
}

function drawMark(image, markColor, badgeCount, badgeColor) {
  if (image.width !== image.height || image.width % LOGICAL_GRID_SIZE !== 0) {
    throw new Error(
      `Icon size must be a square multiple of ${LOGICAL_GRID_SIZE}px`
    );
  }

  const pixelSize = image.width / LOGICAL_GRID_SIZE;
  const drawGridRect = ({ height, width, x, y }, color) => {
    drawRect(
      image,
      x * pixelSize,
      y * pixelSize,
      width * pixelSize,
      height * pixelSize,
      color
    );
  };

  // The mark occupies 30 logical cells and stays inside Android's 66/108 safe zone.
  for (const rectangle of MARK_RECTS) {
    drawGridRect(rectangle, markColor);
  }
  for (const rectangle of BADGE_RECTS.slice(0, badgeCount)) {
    drawGridRect(rectangle, badgeColor);
  }
}

function writePng(relativePath, image) {
  const outputPath = resolve(OUTPUT_ROOT, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, encodePng(image));
}

for (const [name, variant] of Object.entries(VARIANTS)) {
  const iosLight = createImage(ICON_SIZE, ICON_SIZE, variant.light.background);
  drawMark(
    iosLight,
    variant.light.mark,
    variant.badgeCount,
    variant.light.badgeColor
  );
  writePng(`${name}/ios.png`, iosLight);
  writePng(`${name}/ios-light.png`, iosLight);

  const iosDark = createImage(ICON_SIZE, ICON_SIZE, variant.dark.background);
  drawMark(
    iosDark,
    variant.dark.mark,
    variant.badgeCount,
    variant.dark.badgeColor
  );
  writePng(`${name}/ios-dark.png`, iosDark);

  const splashLight = createImage(SPLASH_SIZE, SPLASH_SIZE);
  drawMark(
    splashLight,
    variant.light.mark,
    variant.badgeCount,
    variant.light.badgeColor
  );
  writePng(`${name}/splash-light.png`, splashLight);

  const splashDark = createImage(SPLASH_SIZE, SPLASH_SIZE);
  drawMark(
    splashDark,
    variant.dark.mark,
    variant.badgeCount,
    variant.dark.badgeColor
  );
  writePng(`${name}/splash-dark.png`, splashDark);

  const foreground = createImage(ICON_SIZE, ICON_SIZE);
  drawMark(foreground, variant.mark, variant.badgeCount, variant.badgeColor);
  writePng(`${name}/android-foreground.png`, foreground);

  const monochrome = createImage(ICON_SIZE, ICON_SIZE);
  drawMark(monochrome, COLORS.white, variant.badgeCount, COLORS.white);
  writePng(`${name}/android-monochrome.png`, monochrome);

  const legacy = createImage(ICON_SIZE, ICON_SIZE);
  drawLegacyTile(legacy, variant.background);
  drawMark(legacy, variant.mark, variant.badgeCount, variant.badgeColor);
  writePng(`${name}/android-legacy.png`, legacy);

  const favicon = createImage(
    FAVICON_SIZE,
    FAVICON_SIZE,
    variant.light.background
  );
  drawMark(
    favicon,
    variant.light.mark,
    variant.badgeCount,
    variant.light.badgeColor
  );
  writePng(`${name}/favicon.png`, favicon);
}
