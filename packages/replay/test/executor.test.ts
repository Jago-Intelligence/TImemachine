import { expect, test, vi } from 'vitest';
import { createDockerExecutor } from '../src/index.js';
test('unregistered artifacts and closed executors cannot start containers', async () => {
  const executor = createDockerExecutor([]);
  const fixture = {
    schemaVersion: 1 as const,
    runner: 'express-orders-v1' as const,
    artifactId: `sha256:${'a'.repeat(64)}`,
    profile: 'orders-create-v1' as const,
    quantity: 2,
  };
  await expect(executor.run(fixture)).rejects.toMatchObject({
    code: 'RUNNER_UNAVAILABLE',
  });
  await executor.close();
  await expect(executor.run(fixture)).rejects.toMatchObject({
    code: 'RUNNER_UNAVAILABLE',
  });
});

test('refuses unauthenticated remote Docker endpoints', () => {
  vi.stubEnv('DOCKER_HOST', 'tcp://daemon.example:2375');
  vi.stubEnv('DOCKER_TLS_VERIFY', '');
  try {
    expect(() => createDockerExecutor([])).toThrow('TLS-verified Docker');
  } finally {
    vi.unstubAllEnvs();
  }
});
