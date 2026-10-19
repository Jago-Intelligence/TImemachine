import { expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';

test('overwrites spoofed nonces and gives each page a fresh production script policy', () => {
  vi.stubEnv('NODE_ENV', 'production');
  try {
    const request = new NextRequest('https://dashboard.example.test/', {
      headers: { 'x-nonce': 'attacker', 'content-security-policy': 'script-src *' },
    });
    const a = proxy(request),
      b = proxy(request);
    const policy = a.headers.get('content-security-policy')!;
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).not.toContain('attacker');
    expect(policy).not.toBe(b.headers.get('content-security-policy'));
    expect(a.headers.get('x-middleware-request-content-security-policy')).toBe(policy);
    expect(a.headers.get('cache-control')).toBe('private, no-store');
  } finally {
    vi.unstubAllEnvs();
  }
});
