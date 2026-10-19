import { readFileSync, statSync } from 'node:fs';
import { replayAppRegistrySchema, type ReplayAppRegistry } from '@timemachine/core';
export function readReplayApps(path?: string): ReplayAppRegistry {
  if (!path) return { apps: [] };
  try {
    if (statSync(path).size > 262144) throw new Error('Registry too large');
    return replayAppRegistrySchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new Error('Invalid local replay app registry');
  }
}
