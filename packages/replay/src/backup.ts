import { spawnSync } from 'node:child_process';
import { replayBackupSchema } from '@timemachine/core';
export function backupReplayImage(artifactId: string, repository: string) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*\/[a-z0-9][a-z0-9._\x2f-]*$/.test(repository) ||
    repository.length > 380 ||
    !/^sha256:[a-f0-9]{64}$/.test(artifactId)
  )
    throw new Error('Invalid replay backup repository or image identity.');
  const tag = `${repository}:tm-${artifactId.slice(7)}`;
  if (
    spawnSync('docker', ['tag', artifactId, tag], { stdio: 'ignore', timeout: 10000 })
      .status !== 0 ||
    spawnSync('docker', ['push', tag], { stdio: 'ignore', timeout: 120000 }).status !== 0
  )
    throw new Error(
      'Registry backup failed. Check Docker login and repository permissions; recorder configuration was not updated.',
    );
  const inspected = spawnSync(
    'docker',
    ['image', 'inspect', '--format', '{{json .RepoDigests}}', artifactId],
    { encoding: 'utf8', timeout: 5000 },
  );
  const digests: unknown =
    inspected.status === 0 ? JSON.parse(inspected.stdout) : undefined;
  const reference = Array.isArray(digests)
    ? digests.find(
        (value: unknown) =>
          typeof value === 'string' && value.startsWith(repository + '@sha256:'),
      )
    : undefined;
  return replayBackupSchema.parse({ artifactId, reference });
}
