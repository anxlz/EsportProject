/**
 * Encryption for integration secrets at rest (OAuth tokens, Notion tokens, webhook signing
 * secrets): AES-256-GCM with a random 96-bit IV, bound to the connection by additional
 * authenticated data, so a sealed value copied onto another row doesn't decrypt.
 *
 * Key: INTEGRATIONS_ENCRYPTION_KEY if set, otherwise derived from SESSION_SECRET with HKDF
 * (a separate key in practice; rotating SESSION_SECRET then means reconnecting integrations).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class SecretBox {
  private readonly key: Buffer;

  constructor(material: { encryptionKey?: string; sessionSecret: string }) {
    this.key = material.encryptionKey
      ? Buffer.from(
          hkdfSync('sha256', material.encryptionKey, '', 'integrations-secret-box/v1', 32),
        )
      : Buffer.from(
          hkdfSync(
            'sha256',
            material.sessionSecret,
            'esports-platform',
            'integrations-secret-box/v1',
            32,
          ),
        );
  }

  seal(value: Record<string, unknown>, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      iv.toString('base64url'),
      Buffer.concat([body, tag]).toString('base64url'),
    ].join('.');
  }

  open<T = Record<string, unknown>>(sealed: string, aad: string): T {
    const [version, ivB64, dataB64] = sealed.split('.');
    if (version !== VERSION || !ivB64 || !dataB64) throw new Error('Unknown secret format');
    const data = Buffer.from(dataB64, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString('utf8')) as T;
  }
}

export const SECRET_BOX = Symbol('SECRET_BOX');
