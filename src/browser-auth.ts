import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Reviewer } from './contracts.js';

// These parsers return credential payloads only to the isolated native CLI home.
// Never include them in reports, worker state, logs, or command arguments.
export function browserCredentials(name: Exclude<Reviewer['name'], 'fake'>, input: unknown): unknown {
  try {
    if (name === 'codex') {
      const value = z.object({ OPENAI_API_KEY: z.null().optional(), auth_mode: z.literal('chatgpt').optional(),
        tokens: z.object({ id_token: z.string().min(1), access_token: z.string().min(1), refresh_token: z.string().min(1), account_id: z.string().min(1) }),
        last_refresh: z.string().optional() }).parse(input);
      return { ...value, auth_mode: 'chatgpt', OPENAI_API_KEY: null };
    }
    if (name === 'claude') {
      const value = z.object({ claudeAiOauth: z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1),
        expiresAt: z.number(), scopes: z.array(z.string()), subscriptionType: z.string().min(1), rateLimitTier: z.string().optional(), refreshTokenExpiresAt: z.number().optional() }) }).parse(input);
      return value;
    }
    const entries = z.record(z.string(), z.object({ auth_mode: z.string() }).passthrough()).parse(input);
    const oidc = Object.fromEntries(Object.entries(entries).filter(([, value]) => value.auth_mode === 'oidc').map(([key, value]) => [key,
      z.object({ auth_mode: z.literal('oidc'), key: z.string().min(1), refresh_token: z.string().min(1),
        oidc_issuer: z.string().url(), oidc_client_id: z.string().min(1) }).passthrough().parse(value)]));
    if (!Object.keys(oidc).length) throw new Error();
    // Drop any other auth entries; custom model configurations are not copied.
    return oidc;
  } catch { throw new Error(`${name} browser login is missing or unsupported. Sign in with the official CLI; API-key fallback is disabled.`); }
}

export async function readBrowserCredentials(name: Exclude<Reviewer['name'], 'fake'>): Promise<unknown> {
  const file = name === 'codex' ? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
    : name === 'claude' ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json')
      : join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'auth.json');
  let value: unknown;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { throw new Error(`${name} browser login file is unavailable. Sign in with the official CLI; API-key fallback is disabled.`); }
  return browserCredentials(name, value);
}
