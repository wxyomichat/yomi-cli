import { describe, expect, it } from 'vitest';

import { redact } from '../src/core/redact.js';

/**
 * Redaction of what the CLI may print or log, including the credentials of the QQ and WeChat
 * channels: a header loses its whole value (an `Authorization` value is a scheme and a token),
 * and the QQ and iLink secret fields are masked in JSON, queries and forms.
 */

describe('redact', () => {
  it('drops a header value to the end of the line, whatever the scheme', () => {
    const text = [
      'Authorization: Bearer ilink-bot-token-1',
      'authorization: QQBot qq-access-token-2',
      'X-Token: t3 trailing',
      'Content-Type: application/json',
    ].join('\r\n');
    const result = redact(text);
    for (const secret of ['ilink-bot-token-1', 'qq-access-token-2', 'Bearer', 'QQBot', 't3'])
      expect(result).not.toContain(secret);
    expect(result).toContain('Authorization: ***\r\n');
    expect(result).toContain('authorization: ***\r\n');
    expect(result).toContain('Content-Type: application/json');
    // as a Headers object turned into JSON writes them
    const json = redact(JSON.stringify({ authorization: 'QQBot qq-access-token-3' }));
    expect(json).toBe('{"authorization":"***"}');
  });

  it('masks the QQ and iLink secrets in JSON bodies', () => {
    const body = JSON.stringify({
      appId: '102000001',
      clientSecret: 'cs1',
      access_token: 'at1',
      secret: 'se1',
      bot_token: 'bt1',
      botToken: 'bt2',
      context_token: 'ct1',
      typing_ticket: 'tt1',
      aeskey: 'ak1',
      aes_key: 'ak2',
      encrypt_query_param: 'eq1',
      upload_param: 'up1',
      qrcode: 'qr1',
      qrcode_img_content: 'https://liteapp.weixin.qq.com/q/qr2',
      verify_code: '123456',
      client_secret: 'cs2',
    });
    const result = redact(body);
    for (const secret of [
      'cs1',
      'at1',
      'se1',
      'bt1',
      'bt2',
      'ct1',
      'tt1',
      'ak1',
      'ak2',
      'eq1',
      'up1',
      'qr1',
      'qr2',
      '123456',
      'cs2',
    ])
      expect(result).not.toContain(secret);
    expect(result).toContain('"appId":"102000001"');
    expect(result).toContain('"verify_code":"***"');
    expect(result).toContain('"qrcode":"***"');
  });

  it('masks them in queries and forms', () => {
    const result = redact(
      'GET /ilink/bot/get_qrcode_status?qrcode=qr9&verify_code=4321 client_secret=cs9&x=1',
    );
    for (const secret of ['qr9', '4321', 'cs9']) expect(result).not.toContain(secret);
    expect(result).toContain('x=1');
  });

  it('still strips what it always did', () => {
    const text = [
      '{"auth_token":"a1","refresh_token":"r1","firebase_token":"f1","name":"ok"}',
      'wss://h/connection/ws?app_id=1&token=r2&user_id=3',
      'state=s1&id_token=i1',
      'X-Token: t1',
      'POST https://api.telegram.org/bot123456789:AAbbccddeeffgghhiijjkkllmmnnooppqqr/getMe',
    ].join('\n');
    const result = redact(text);
    for (const secret of ['a1', 'r1', 'f1', 'r2', 's1', 'i1', 't1'])
      expect(result).not.toMatch(new RegExp(`\\b${secret}\\b`));
    expect(result).not.toContain('AAbbccddeeff');
    expect(result).toContain('/bot123456789:***/getMe');
    expect(result).toContain('"name":"ok"');
    expect(result).toContain('user_id=3');
  });
});
