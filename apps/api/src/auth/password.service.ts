import { Injectable } from '@nestjs/common';

/**
 * Password hashing with Argon2id via Bun's built-in implementation (no native addon to build).
 * Wrapped in a service so the algorithm can be swapped without touching callers.
 */
@Injectable()
export class PasswordService {
  /**
   * A real Argon2id hash of a random string, verified against when the email is unknown so that
   * "no such user" and "wrong password" take the same time (no account enumeration by timing).
   */
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: 19456, timeCost: 2 });
  }

  async verify(password: string, hash: string | null): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= this.hash(crypto.randomUUID());
      await Bun.password.verify(password, await this.dummyHash);
      return false;
    }
    return Bun.password.verify(password, hash);
  }
}
