import { describe, expect, it } from 'vitest';

import {
  encodeQr,
  QR_MASK,
  QR_QUIET,
  QrTooLong,
  qrVersionFor,
  qrWidth,
  renderQr,
} from '../src/relay/channels/qr.js';

/**
 * The QR encoder of the WeChat login (design §8, C2): byte mode, level M, versions 1-10, mask 0.
 * The fixtures are whole module matrices produced once by a reference encoder (node-qrcode 1.5.4,
 * `errorCorrectionLevel: 'M'`, `maskPattern: 0`, one byte-mode segment) and committed: one row per
 * string, as hex of the row's modules (dark = 1) padded to whole hex digits. They cover a version
 * 1 code, a typical login link (version 6, four blocks) and a long one (version 10: version
 * information, five blocks of two lengths, a 16-bit length field). The same matrices, drawn as an
 * image, were read back by a barcode scanner (zbarimg) when the fixtures were made.
 */

const VECTORS: { text: string; version: number; rows: string[] }[] = [
  {
    text: 'yomi',
    version: 1,
    rows: [
      'fe03f8',
      '82fa08',
      'ba02e8',
      'ba62e8',
      'badae8',
      '823208',
      'feabf8',
      '000000',
      'aa0890',
      'b1b538',
      'daf758',
      '301d80',
      'e35700',
      '00e228',
      'fe48f8',
      '820210',
      'baaa98',
      'ba5570',
      'ba9768',
      '821dd0',
      'fef738',
    ],
  },
  {
    text: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=0a1b2c3d4e5f60718293a4b5c6d7e8f9&bot_type=3',
    version: 6,
    rows: [
      'fe4bdb59bf8',
      '82a73539a08',
      'ba04f168ae8',
      'ba727dfdae8',
      'ba9f3db62e8',
      '823cd5dfa08',
      'feaaaaaabf8',
      '000e67d5000',
      'aa30c4c5890',
      '34866aecb68',
      'de9a6862038',
      'bc52cfd6808',
      '17efd6c5650',
      '386617d2328',
      'b21621823c8',
      'fcc674d5b10',
      'c293ef4f318',
      '6c6e4a4a218',
      'fea4ac244b8',
      '15b9f060b08',
      '9276b8a0b08',
      '80ae68e8a18',
      'da75a2a26b8',
      '5092f5cee00',
      '5f936cfca60',
      '5109c4ce218',
      '5a01ea603b8',
      '51bbecfec18',
      '42517c4f748',
      '197b7d5e638',
      '86b1dc7e178',
      '6c6b4f4dec8',
      '9ff754f6f88',
      '008b04a6898',
      'fe02c243af8',
      '825c9f978d8',
      'ba920292fd0',
      'ba5482874a0',
      'baf402409d8',
      '827656d5110',
      'fef40d4ddd8',
    ],
  },
  {
    text: 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9&bot_type=3&lang=zh_CN&scene=ilink-login&ext=yomi-cli-test-vector-number-three',
    version: 10,
    rows: [
      'fe0c74bbe47f3f8',
      '8281d2bf64e5208',
      'ba39efbfe0732e8',
      'ba2269a344412e8',
      'ba884dbfaf6d2e8',
      '824b9de32676208',
      'feaaaaaaaaaabf8',
      '00378923beab000',
      'aa31a33e8a9a090',
      '907c30202510198',
      'a756bde02d805b8',
      '48825706a0dcac8',
      'c6afaccf8c9d6d0',
      '211c44a100051f8',
      'dbb4be0d88859b8',
      'e57f9abacecf590',
      '2a36422e9faa5f0',
      'c43977415044558',
      '83d1eee1c00c4d8',
      '3845380adc09480',
      '3746d6498e8e7d8',
      'b093aa428444578',
      '07dca43306dd4b8',
      'a5b1fe8b2fc8998',
      '93185f0d6f9e0c0',
      '01be5d1d80c0598',
      '4fb1247f494dfb8',
      'c8e4d363cdff888',
      'cae8792bf9dfa88',
      'b8e2a82245d0898',
      '4fdff17f6d9cfb8',
      '55639ac2d09cb08',
      '5ee02387d6fc208',
      '81ae19409c91b28',
      '722719d31590640',
      'bc1bcd438bbc690',
      '5361032bf998428',
      '606b586d840ce18',
      '8738ab2799cc7b8',
      'f5aa196fab1a218',
      '1bf8e402c91e918',
      'e03a02621bd0708',
      'a3bcefef5b58bb8',
      '6147136e7b9c680',
      'c3b8d632f9f8350',
      '38cfde700d04808',
      'a65573fa8919ee8',
      'f9b76321aea8e48',
      '0288db7f9efafc8',
      '00eaed62bc80898',
      'fe34dbab3490af8',
      '820e396226988d8',
      'ba8320ffcafafc8',
      'ba3b02f90145cd0',
      'bab1b47d88a5bc8',
      '82280a90d98ec90',
      'fee88162d9ced38',
    ],
  },
];

/** The matrix as the fixtures write it. */
function hexRows(modules: boolean[][]): string[] {
  return modules.map((row) => {
    const bits = row.map((dark) => (dark ? '1' : '0')).join('');
    const padded = bits.padEnd(Math.ceil(bits.length / 4) * 4, '0');
    let hex = '';
    for (let at = 0; at < padded.length; at += 4)
      hex += parseInt(padded.slice(at, at + 4), 2).toString(16);
    return hex;
  });
}

describe('the QR encoder', () => {
  it('matches the reference encoder module for module (mask 0, level M, byte mode)', () => {
    expect(QR_MASK).toBe(0);
    for (const vector of VECTORS) {
      const modules = encodeQr(vector.text);
      expect(modules.length, vector.text).toBe(vector.version * 4 + 17);
      expect(qrVersionFor(Buffer.byteLength(vector.text))).toBe(vector.version);
      expect(hexRows(modules), vector.text).toEqual(vector.rows);
    }
  });

  it('picks the smallest version that holds the bytes, and refuses beyond version 10', () => {
    // Level M byte capacities of versions 1-10.
    const capacity = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    capacity.forEach((bytes, index) => {
      expect(qrVersionFor(bytes)).toBe(index + 1);
      expect(qrVersionFor(bytes + 1)).toBe(index + 2 > 10 ? null : index + 2);
    });
    expect(() => encodeQr('x'.repeat(214))).toThrow(QrTooLong);
    // UTF-8 bytes count, not characters: 71 Chinese characters are 213 bytes.
    expect(encodeQr('微'.repeat(71))).toHaveLength(57);
    expect(() => encodeQr('微'.repeat(72))).toThrow(QrTooLong);
  });

  it('draws two module rows per line with a quiet zone, black on white or light blocks', () => {
    const modules = encodeQr('yomi');
    const width = qrWidth(modules.length);
    expect(width).toBe(21 + QR_QUIET * 2);
    const plain = renderQr(modules, false);
    expect(plain).toHaveLength(Math.ceil(width / 2));
    for (const line of plain) expect([...line]).toHaveLength(width);
    // Without colours the light modules are drawn: the quiet zone is a full block.
    expect(plain[0]).toBe('█'.repeat(width));
    // The top-left finder: its dark top row is blank, under it the light ring between two dark
    // modules.
    expect(plain[1].slice(QR_QUIET, QR_QUIET + 7)).toBe(' ▄▄▄▄▄ ');
    const colour = renderQr(modules, true);
    expect(colour[0].startsWith('\u001b[30;47m')).toBe(true);
    expect(colour[0].endsWith('\u001b[0m')).toBe(true);
    // With colours the dark modules are drawn: the quiet zone is blank (white background).
    const first = colour[0].replace(/\u001b\[[0-9;]*m/g, '');
    expect(first).toBe(' '.repeat(width));
    // Every module of every row is shown once: the drawing round-trips to the matrix.
    const back: boolean[][] = [];
    for (const line of colour.map((text) => text.replace(/\u001b\[[0-9;]*m/g, ''))) {
      const top: boolean[] = [];
      const bottom: boolean[] = [];
      for (const character of line) {
        top.push(character === '█' || character === '▀');
        bottom.push(character === '█' || character === '▄');
      }
      back.push(top, bottom);
    }
    const inner = back
      .slice(QR_QUIET, QR_QUIET + modules.length)
      .map((row) => row.slice(QR_QUIET, QR_QUIET + modules.length));
    expect(inner).toEqual(modules);
  });
});
