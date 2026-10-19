import { readReplayApps } from './registry.js';
import { createDockerExecutor } from './index.js';
import { matchesReplayExpectation } from '@timemachine/core';
export async function checkReplayApp(args: string[]): Promise<void> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !key ||
      !['--service', '--profile', '--registry'].includes(key) ||
      !value ||
      flags.has(key)
    )
      throw new Error('Invalid check arguments');
    flags.set(key, value);
  }
  const registry = readReplayApps(
    flags.get('--registry') ?? '.timemachine/replay-apps.json',
  );
  const app = registry.apps.find((app) => app.service === flags.get('--service'));
  const fixture = app?.fixtures.find(
    (fixture) => fixture.profile === flags.get('--profile'),
  );
  if (!app || !fixture) throw new Error('Registered app/scenario not found');
  const executor = createDockerExecutor([app.currentArtifactId]);
  try {
    const actual = await executor.run(fixture);
    if (!matchesReplayExpectation(actual, fixture.target))
      throw new Error('Application regression failed');
  } finally {
    await executor.close();
  }
  console.log(
    'Registered application scenario passed its response and business assertions.',
  );
}
