import { describe, expect, test } from 'bun:test';
import { PasswordService } from '../src/auth/password.service.js';

describe('password hashing', () => {
  const passwords = new PasswordService();

  test('hashes and verifies Argon2id passwords', async () => {
    const hash = await passwords.hash('a strong test password');

    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await passwords.verify('a strong test password', hash)).toBe(true);
    expect(await passwords.verify('a different password', hash)).toBe(false);
  });

  test('verifies existing Bun Argon2id hashes', async () => {
    const hash = await Bun.password.hash('existing Bun password', {
      algorithm: 'argon2id',
      memoryCost: 19456,
      timeCost: 2,
    });

    expect(await passwords.verify('existing Bun password', hash)).toBe(true);
  });

  test('performs dummy verification when no hash exists', async () => {
    expect(await passwords.verify('any password', null)).toBe(false);
  });
});
