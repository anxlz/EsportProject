import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Password hashing with Argon2id. Use a Node-compatible implementation because the API runs on
 * Node in Vercel and Bun locally.
 */
@Injectable()
export class PasswordService {
  /**
   * A real Argon2id hash of a random string, verified against when the email is unknown so that
   * "no such user" and "wrong password" take the same time (no account enumeration by timing).
   */
  private dummyHash: Promise<string> | null = null;

  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
  }

  async verify(password: string, hash: string | null): Promise<boolean> {
    if (!hash) {
      this.dummyHash ??= this.hash(crypto.randomUUID());
      await argon2.verify(await this.dummyHash, password);
      return false;
    }
    return argon2.verify(hash, password);
  }
}
