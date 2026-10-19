import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { initializeProject, diagnoseProject } from '../src/setup-cli.js';
import { recordingPolicySchema } from '../src/recording-policy.js';

it('creates valid private-safe starter configuration without overwriting existing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-init-'));
  try {
    writeFileSync(join(root, '.env'), 'PRIVATE=preserve');
    initializeProject(root, 'my-api');
    const policy = JSON.parse(
      readFileSync(join(root, 'timemachine/recording-policy.json'), 'utf8'),
    );
    expect(recordingPolicySchema.parse(policy).requests).toEqual([]);
    expect(readFileSync(join(root, 'timemachine/.gitignore'), 'utf8')).toContain('.env');
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('PRIVATE=preserve');
    expect(() => initializeProject(root, 'my-api')).toThrow('already exists');
    expect(() => initializeProject(root, "unsafe'")).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('diagnoses starter gaps offline without networking or leaking credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-doctor-'));
  try {
    initializeProject(root, 'my-api');
    const fetcher = vi.fn();
    const token = 'private-credential'.repeat(3);
    const results = await diagnoseProject(
      root,
      { TIMEMACHINE_AUTH_TOKEN: token, TIMEMACHINE_SERVICE_NAME: 'my-api' },
      true,
      fetcher,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(results.some((row) => row.status === 'fail')).toBe(false);
    expect(results.filter((row) => row.status === 'warn').length).toBeGreaterThan(1);
    expect(JSON.stringify(results)).not.toContain(token);
    writeFileSync(join(root, 'timemachine/recording-policy.json'), '{invalid');
    expect(
      (await diagnoseProject(root, {}, true, fetcher)).some(
        (row) => row.status === 'fail',
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('checks readiness and authenticated access with bounded requests and no redirects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-doctor-'));
  try {
    initializeProject(root, 'my-api');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const results = await diagnoseProject(
      root,
      { TIMEMACHINE_AUTH_TOKEN: 'x'.repeat(32) },
      false,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      redirect: 'error',
      headers: { authorization: `Bearer ${'x'.repeat(32)}` },
    });
    expect(results).toContainEqual({
      status: 'fail',
      message: 'Authenticated collector access: rejected or unavailable.',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('validates matching replay artifacts and reports routes without a contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-doctor-'));
  try {
    initializeProject(root, 'my-api');
    const artifact = `sha256:${'a'.repeat(64)}`;
    const path = join(root, 'timemachine/recording-policy.json');
    writeFileSync(
      path,
      JSON.stringify({
        id: 'test',
        requests: [{ method: 'POST', route: '/quote', bodyFields: ['distanceKm'] }],
        dependencies: [],
      }),
    );
    const registry = join(root, 'registry.json');
    writeFileSync(
      registry,
      JSON.stringify({
        apps: [
          {
            service: 'my-api',
            currentArtifactId: artifact,
            artifacts: [artifact],
            fixtures: [
              {
                schemaVersion: 1,
                runner: 'express-app-v1',
                artifactId: artifact,
                contractHash: 'b'.repeat(64),
                inputMode: 'recorded-http',
                service: 'my-api',
                profile: 'test-v1',
                scenarioVersion: 'v1',
                method: 'POST',
                route: '/quote',
                failureCode: 'HTTP_500',
                target: {
                  statusCode: 200,
                  errorCode: null,
                  outcome: 'scenario-assertions-passed',
                },
              },
            ],
          },
        ],
      }),
    );
    const env = {
      TIMEMACHINE_AUTH_TOKEN: 'x'.repeat(32),
      TIMEMACHINE_SERVICE_NAME: 'my-api',
      TIMEMACHINE_REPLAY_ARTIFACT_ID: artifact,
      REPLAY_APPS_FILE: registry,
    };
    const results = await diagnoseProject(root, env, true);
    expect(results).toContainEqual({
      status: 'pass',
      message: 'Service replay registration matches the recorder artifact.',
    });
    expect(results.some((row) => row.message.includes('has no recorded-request'))).toBe(
      false,
    );
    const changed = await diagnoseProject(
      root,
      { ...env, TIMEMACHINE_REPLAY_ARTIFACT_ID: `sha256:${'c'.repeat(64)}` },
      true,
    );
    expect(changed.some((row) => row.message.includes('does not match'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
