import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export const COOKIE_NAME = 'timemachine_session';
export const SESSION_SECONDS = 8 * 60 * 60;
export function passwordMatches(input: string, expected: string): boolean {
  const digest = (value: string) =>
    createHmac('sha256', 'timemachine-password-comparison').update(value).digest();
  return input.length <= 256 && timingSafeEqual(digest(input), digest(expected));
}
export function createSession(
  secret: string,
  now = Date.now(),
  workspaceSession?: string,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      ...(workspaceSession ? { sid: workspaceSession } : {}),
      exp: Math.floor(now / 1000) + SESSION_SECONDS,
      nonce: randomBytes(24).toString('hex'),
    }),
  ).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function validSession(
  value: string | undefined,
  secret: string,
  now = Date.now(),
): boolean {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
    return false;
  try {
    const [payload, signature, extra] = value.split('.');
    if (!payload || !signature || extra !== undefined) return false;
    const expected = createHmac('sha256', secret).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return false;
    const body: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      typeof body !== 'object' ||
      !body ||
      !('v' in body) ||
      !('exp' in body) ||
      body.v !== 1 ||
      typeof body.exp !== 'number'
    )
      return false;
    const time = Math.floor(now / 1000);
    return (
      Number.isInteger(body.exp) && body.exp > time && body.exp <= time + SESSION_SECONDS
    );
  } catch {
    return false;
  }
}
let windowStart = 0;
let attempts = 0;
export function allowLogin(now = Date.now()): boolean {
  if (now - windowStart >= 60000) {
    windowStart = now;
    attempts = 0;
  }
  return ++attempts <= 20;
}

export function workspaceSession(
  value: string | undefined,
  secret: string,
): string | undefined {
  if (!validSession(value, secret)) return undefined;
  try {
    const sid = JSON.parse(
      Buffer.from(value!.split('.')[0]!, 'base64url').toString('utf8'),
    ).sid;
    return typeof sid === 'string' && /^ws_[a-f0-9]{64}$/.test(sid) ? sid : undefined;
  } catch {
    return undefined;
  }
}
