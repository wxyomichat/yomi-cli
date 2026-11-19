/**
 * A small QR code encoder for the WeChat login (`yomi relay --channel wechat --experimental
 * --login`), so the terminal can show the code without a dependency. It does only what a login
 * link needs: byte mode, error correction level M, versions 1 to 10 (up to 213 bytes), and one
 * fixed mask pattern. Any of the eight masks scans; the specification's penalty scoring only picks
 * the one that is easiest on a poor scanner, so it is left out (design §8, C2). The test compares
 * whole module matrices with a reference encoder forced to the same mask.
 *
 * The drawing uses half blocks (two module rows per text line). With colours it is black on
 * white; without, the light modules are drawn as `█`, for the usual dark terminal.
 */

/** The mask pattern every code uses: (row + column) mod 2 == 0 (pattern 000). */
export const QR_MASK = 0;
/** The highest version drawn: 57 × 57 modules, 213 bytes at level M. */
export const QR_MAX_VERSION = 10;
/** Light modules around the code, on each side. */
export const QR_QUIET = 2;

/** Level M per version (index = version): error correction codewords per block, and blocks. */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** All codewords (data and error correction) per version. */
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
/** Centres of the alignment patterns per version (rows and columns). */
const ALIGNMENT = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];
/** Level M in the format information. */
const FORMAT_LEVEL_M = 0;

export class QrTooLong extends Error {
  constructor(readonly bytes: number) {
    super(`QR: ${bytes} bytes do not fit version ${QR_MAX_VERSION} at level M`);
    this.name = 'QrTooLong';
  }
}

const dataCodewords = (version: number) =>
  TOTAL_CODEWORDS[version] - ECC_PER_BLOCK[version] * BLOCKS[version];

/** Byte mode: 4 bits of mode, the length (8 bits, 16 from version 10), then the bytes. */
const countBits = (version: number) => (version < 10 ? 8 : 16);

/** The smallest version (1-10) that holds `length` bytes at level M; null when none does. */
export function qrVersionFor(length: number): number | null {
  for (let version = 1; version <= QR_MAX_VERSION; version++)
    if (4 + countBits(version) + length * 8 <= dataCodewords(version) * 8) return version;
  return null;
}

// --- Reed-Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 -------------------------------------

function multiply(x: number, y: number): number {
  let z = 0;
  for (let bit = 7; bit >= 0; bit--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> bit) & 1) * x;
  }
  return z & 0xff;
}

/** The generator polynomial of `degree`, highest coefficient first, the leading 1 left out. */
function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index++) {
    for (let at = 0; at < result.length; at++) {
      result[at] = multiply(result[at], root);
      if (at + 1 < result.length) result[at] ^= result[at + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function remainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number);
    result.push(0);
    for (let index = 0; index < result.length; index++)
      result[index] ^= multiply(generator[index], factor);
  }
  return result;
}

// --- Codewords ---------------------------------------------------------------------------------

/** The data codewords: mode, length, bytes, terminator, padding to a byte, pad bytes. */
function encodeData(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const append = (value: number, length: number) => {
    for (let bit = length - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, countBits(version));
  for (const byte of bytes) append(byte, 8);
  const capacity = dataCodewords(version) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  const codewords: number[] = [];
  for (let at = 0; at < bits.length; at += 8)
    codewords.push(bits.slice(at, at + 8).reduce((value, bit) => (value << 1) | bit, 0));
  for (let pad = 0xec; codewords.length < dataCodewords(version); pad ^= 0xec ^ 0x11)
    codewords.push(pad);
  return codewords;
}

/** Splits the data into blocks, adds each block's error correction, and interleaves them. */
function interleave(data: readonly number[], version: number): number[] {
  const blocks = BLOCKS[version];
  const ecc = ECC_PER_BLOCK[version];
  const total = TOTAL_CODEWORDS[version];
  const shortBlocks = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks);
  const generator = divisor(ecc);
  const all: number[][] = [];
  let at = 0;
  for (let index = 0; index < blocks; index++) {
    const length = shortLength - ecc + (index < shortBlocks ? 0 : 1);
    const block = data.slice(at, at + length);
    at += length;
    const correction = remainder(block, generator);
    // A short block gets a placeholder where the long ones have one more data codeword.
    if (index < shortBlocks) block.push(0);
    all.push([...block, ...correction]);
  }
  const result: number[] = [];
  for (let column = 0; column < all[0].length; column++)
    for (let index = 0; index < all.length; index++)
      if (column !== shortLength - ecc || index >= shortBlocks) result.push(all[index][column]);
  return result;
}

// --- The module matrix --------------------------------------------------------------------------

class Grid {
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  /** A function module (finder, timing, alignment, format, version) at column x, row y. */
  set(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }
}

function drawFinder(grid: Grid, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      grid.set(x, y, distance !== 2 && distance !== 4);
    }
}

function drawAlignment(grid: Grid, cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      grid.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
}

/** The 15 format bits (level M, the mask), in both copies, and the dark module. */
function drawFormat(grid: Grid, mask: number) {
  const data = (FORMAT_LEVEL_M << 3) | mask;
  let rest = data;
  for (let index = 0; index < 10; index++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
  const bits = ((data << 10) | rest) ^ 0x5412;
  const bit = (index: number) => ((bits >>> index) & 1) !== 0;
  const size = grid.size;
  for (let index = 0; index <= 5; index++) grid.set(8, index, bit(index));
  grid.set(8, 7, bit(6));
  grid.set(8, 8, bit(7));
  grid.set(7, 8, bit(8));
  for (let index = 9; index < 15; index++) grid.set(14 - index, 8, bit(index));
  for (let index = 0; index < 8; index++) grid.set(size - 1 - index, 8, bit(index));
  for (let index = 8; index < 15; index++) grid.set(8, size - 15 + index, bit(index));
  grid.set(8, size - 8, true);
}

/** The 18 version bits (versions 7 and up), in both corners. */
function drawVersion(grid: Grid, version: number) {
  if (version < 7) return;
  let rest = version;
  for (let index = 0; index < 12; index++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
  const bits = (version << 12) | rest;
  for (let index = 0; index < 18; index++) {
    const dark = ((bits >>> index) & 1) !== 0;
    const a = grid.size - 11 + (index % 3);
    const b = Math.floor(index / 3);
    grid.set(a, b, dark);
    grid.set(b, a, dark);
  }
}

function drawFunctionPatterns(grid: Grid, version: number) {
  const size = grid.size;
  for (let index = 0; index < size; index++) {
    grid.set(6, index, index % 2 === 0);
    grid.set(index, 6, index % 2 === 0);
  }
  drawFinder(grid, 3, 3);
  drawFinder(grid, size - 4, 3);
  drawFinder(grid, 3, size - 4);
  const centres = ALIGNMENT[version];
  const last = centres.length - 1;
  for (let i = 0; i < centres.length; i++)
    for (let j = 0; j < centres.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      drawAlignment(grid, centres[i], centres[j]);
    }
  // Reserved now, written with the mask at the end.
  drawFormat(grid, 0);
  drawVersion(grid, version);
}

/** The codewords in the zigzag order, two columns at a time from the right, skipping column 6. */
function placeCodewords(grid: Grid, codewords: readonly number[]) {
  const size = grid.size;
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++)
      for (let column = 0; column < 2; column++) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        if (grid.reserved[y][x] || index >= codewords.length * 8) continue;
        grid.modules[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
        index += 1;
      }
  }
}

function applyMask(grid: Grid, mask: number) {
  if (mask !== 0) throw new Error(`QR: mask ${mask} is not implemented`);
  for (let y = 0; y < grid.size; y++)
    for (let x = 0; x < grid.size; x++)
      if (!grid.reserved[y][x] && (x + y) % 2 === 0) grid.modules[y][x] = !grid.modules[y][x];
}

/**
 * The module matrix of `text` (UTF-8, byte mode, level M, mask 0): rows top to bottom, `true` for
 * dark. Throws `QrTooLong` beyond version 10.
 */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  if (version === null) throw new QrTooLong(bytes.length);
  const grid = new Grid(version * 4 + 17);
  drawFunctionPatterns(grid, version);
  placeCodewords(grid, interleave(encodeData(bytes, version), version));
  applyMask(grid, QR_MASK);
  drawFormat(grid, QR_MASK);
  return grid.modules;
}

/** How many terminal columns the drawing of a `size` × `size` code takes. */
export const qrWidth = (size: number) => size + QR_QUIET * 2;

/**
 * The code as terminal lines, two module rows per line, with the quiet zone. `colour`: black on
 * white with ANSI colours; else the light modules are `█` (for a dark terminal without colours).
 */
export function renderQr(modules: readonly (readonly boolean[])[], colour: boolean): string[] {
  const size = modules.length;
  const dark = (x: number, y: number) =>
    x >= QR_QUIET &&
    y >= QR_QUIET &&
    x < size + QR_QUIET &&
    y < size + QR_QUIET &&
    modules[y - QR_QUIET][x - QR_QUIET];
  const full = size + QR_QUIET * 2;
  const lines: string[] = [];
  for (let y = 0; y < full; y += 2) {
    let line = '';
    for (let x = 0; x < full; x++) {
      // What is drawn: the dark modules with colours, the light ones without. Below the last
      // row (the size is odd) nothing is drawn.
      const upper = colour ? dark(x, y) : !dark(x, y);
      const lower = y + 1 < full && (colour ? dark(x, y + 1) : !dark(x, y + 1));
      line += upper && lower ? '█' : upper ? '▀' : lower ? '▄' : ' ';
    }
    lines.push(colour ? `\u001b[30;47m${line}\u001b[0m` : line);
  }
  return lines;
}
