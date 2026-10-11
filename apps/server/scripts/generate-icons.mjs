/**
 * Generates every icon T³ ships from the two source drawings in `apps/web/icon/`.
 *
 *   pnpm --filter @t3/server exec node scripts/generate-icons.mjs
 *
 * Sources: `icon_white_background.png` (used wherever the icon sits on an unknown
 * surface: the launcher, the tray, the Android legacy launcher icon, the boot
 * screen) and `icon_transparent_background.png` (used where the surface already
 * provides the background: the Android adaptive foreground, the maskable icon).
 *
 * Run it again after the artwork changes; nothing else has to be edited by hand.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const white = join(repo, 'apps/web/icon/icon_white_background.png');
const transparent = join(repo, 'apps/web/icon/icon_transparent_background.png');
const androidRes = join(repo, 'spikes/001-android-webview-shell/android/app/src/main/res');
const webIcons = join(repo, 'apps/web/public/icons');

const write = async (target, buffer) => {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  return buffer.length;
};

/** The drawing keeps a small margin; trim it once per source so every size fills the same way. */
const trimmedCache = new Map();
async function trimmed(source) {
  if (!trimmedCache.has(source)) {
    trimmedCache.set(source, await sharp(source).trim({ threshold: 8 }).png().toBuffer());
  }
  return trimmedCache.get(source);
}

async function squareFrom(source, size, { background = null, scale = 0.86 } = {}) {
  const inner = Math.round(size * scale);
  const logo = await sharp(await trimmed(source)).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const base = background === null
    ? sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    : sharp({ create: { width: size, height: size, channels: 4, background } });
  return base.composite([{ input: logo, gravity: 'center' }]).png().toBuffer();
}

const OPAQUE_WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** A multi-size .ico whose entries are PNGs (Vista and later read those directly). */
function icoFrom(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const directory = Buffer.alloc(16 * pngs.length);
  let offset = header.length + directory.length;
  pngs.forEach(({ size, buffer }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 0);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(buffer.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += buffer.length;
  });
  return Buffer.concat([header, directory, ...pngs.map((entry) => entry.buffer)]);
}

const report = [];

// --- Web: favicon, install icons, the boot screen's own copy -----------------
for (const size of [192, 512]) {
  report.push([`web icons/icon-${size}.png`, await write(join(webIcons, `icon-${size}.png`), await squareFrom(transparent, size))]);
}
// A maskable icon is cropped to a circle by the launcher, so the drawing stays well inside.
report.push(['web icons/icon-maskable-512.png', await write(join(webIcons, 'icon-maskable-512.png'),
  // A maskable icon is cropped to a circle of 80% of the square, so the logo's
  // diagonal has to fit inside it: 0.8 / sqrt(2) is the largest square that does.
  await squareFrom(transparent, 512, { background: OPAQUE_WHITE, scale: 0.56 }))]);
// iOS composites transparency onto black, so this one is opaque to its edges.
report.push(['web icons/apple-touch-icon.png', await write(join(webIcons, 'apple-touch-icon.png'),
  await squareFrom(transparent, 180, { background: OPAQUE_WHITE }))]);
// Filling its own box on purpose: the boot screen sets a width, and that width has to be the
// size the drawing is actually seen at (the launch screen's icon size).
report.push(['web icons/boot.png', await write(join(webIcons, 'boot.png'), await squareFrom(transparent, 256, { scale: 1 }))]);

const favicon = [];
for (const size of [16, 24, 32, 48, 64]) {
  favicon.push({ size, buffer: await squareFrom(transparent, size) });
}
report.push(['web favicon.ico', await write(join(repo, 'apps/web/public/favicon.ico'), icoFrom(favicon))]);

// --- Android: legacy launcher, round, adaptive foreground, splash -------------
const DENSITIES = [
  ['mdpi', 48, 108],
  ['hdpi', 72, 162],
  ['xhdpi', 96, 216],
  ['xxhdpi', 144, 324],
  ['xxxhdpi', 192, 432],
];
const roundMask = (size) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
);
for (const [density, size, foregroundSize] of DENSITIES) {
  const dir = join(androidRes, `mipmap-${density}`);
  // Legacy launcher icons are opaque to their edges: pre-adaptive launchers paint no plate
  // behind them, so a transparent margin would show the wallpaper through the icon.
  report.push([`android mipmap-${density}/ic_launcher.png`, await write(join(dir, 'ic_launcher.png'),
    await squareFrom(transparent, size, { background: OPAQUE_WHITE }))]);
  const round = await sharp(await squareFrom(transparent, size, { background: OPAQUE_WHITE }))
    .composite([{ input: roundMask(size), blend: 'dest-in' }]).png().toBuffer();
  report.push([`android mipmap-${density}/ic_launcher_round.png`, await write(join(dir, 'ic_launcher_round.png'), round)]);
  // The adaptive foreground is drawn at 108dp with the logo inside the 72dp safe zone.
  report.push([`android mipmap-${density}/ic_launcher_foreground.png`,
    await write(join(dir, 'ic_launcher_foreground.png'), await squareFrom(transparent, foregroundSize, { scale: 0.6 }))]);
}

/*
  The launch screen's icon is deliberately *not* drawn (see values/styles.xml): the system
  scales it into a 288dp box and animates the splash away itself, so an icon here blinks
  between the launch screen and the boot screen. The measurement, should it be revisited:
  the system's box is 288dp and a drawing at 0.62 of it renders at ~178dp.
*/

const SPLASH = [
  ['drawable', 480, 320],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
];
for (const [dir, width, height] of SPLASH) {
  /*
    The launch window's background is plain white, with no icon: it is the same white the
    boot screen is, so the icon appears exactly once — in the boot screen, where its size is
    the page's to decide. A splash bitmap is scaled to the screen, so an icon baked into it
    can never match the boot screen's icon on every device; not drawing one removes the
    question (and the visible shrink that came with it).
  */
  const image = await sharp({ create: { width, height, channels: 4, background: OPAQUE_WHITE } })
    .png().toBuffer();
  report.push([`android ${dir}/splash.png`, await write(join(androidRes, dir, 'splash.png'), image)]);
}

// --- Windows launcher: the exe, its window and the tray ----------------------
const windows = [];
// The tray and the taskbar paint their own background: the drawing goes on its own.
for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  windows.push({ size, buffer: await squareFrom(transparent, size) });
}
report.push(['launcher t3.ico', await write(join(repo, 'tools/t3-launcher/t3.ico'), icoFrom(windows))]);

for (const [name, bytes] of report) {
  process.stdout.write(`${name.padEnd(48)} ${(bytes / 1024).toFixed(1)} KB\n`);
}
process.stdout.write(`\nsources: ${readFileSync(white).length} + ${readFileSync(transparent).length} bytes\n`);
