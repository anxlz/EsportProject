/**
 * Minimal Discord OAuth2 client (authorization-code flow, scopes: identify email).
 * Behind an injection token so tests replace it with a fake — no test ever calls Discord.
 */
import { Inject, Injectable } from '@nestjs/common';
import { type Env, ENV } from '../config/env.js';

export interface DiscordProfile {
  id: string;
  username: string;
  globalName: string | null;
  email: string | null;
  verified: boolean;
}

export interface DiscordOAuthClient {
  authorizeUrl(state: string): string;
  fetchProfile(code: string): Promise<DiscordProfile>;
}

export const DISCORD_CLIENT = Symbol('DISCORD_CLIENT');

const DISCORD_API = 'https://discord.com/api/v10';

@Injectable()
export class HttpDiscordOAuthClient implements DiscordOAuthClient {
  constructor(@Inject(ENV) private readonly env: Env) {}

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.env.DISCORD_CLIENT_ID ?? '',
      redirect_uri: this.env.DISCORD_REDIRECT_URI ?? '',
      response_type: 'code',
      scope: 'identify email',
      state,
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  async fetchProfile(code: string): Promise<DiscordProfile> {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.env.DISCORD_REDIRECT_URI ?? '',
        client_id: this.env.DISCORD_CLIENT_ID ?? '',
        client_secret: this.env.DISCORD_CLIENT_SECRET ?? '',
      }),
    });
    if (!tokenRes.ok) throw new Error(`Discord token exchange failed (${tokenRes.status})`);
    const token = (await tokenRes.json()) as { access_token: string };

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) throw new Error(`Discord profile request failed (${userRes.status})`);
    const u = (await userRes.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      email?: string | null;
      verified?: boolean;
    };
    return {
      id: u.id,
      username: u.username,
      globalName: u.global_name ?? null,
      email: u.email ?? null,
      verified: u.verified ?? false,
    };
  }
}
