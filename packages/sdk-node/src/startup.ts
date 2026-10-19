import { projectEnvironment } from './project-config.js';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

export const startupSchema = z.strictObject({
  version: z.literal(1),
  entrypoint: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => !value.startsWith('-') && !/[\r\n\0]/.test(value)),
  nodeArgs: z.array(z.string().max(1024)).max(20).default([]),
  envFile: z.string().min(1).max(1024).default('timemachine/.env'),
});
export type StartupConfig = z.input<typeof startupSchema>;

function read(path: string) {
  if (statSync(path).size > 65536) throw new Error('Startup configuration too large');
  return readFileSync(path, 'utf8');
}
export function projectPath(root: string, value: string) {
  const path = resolve(root, value),
    rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))
    throw new Error('Startup paths must be inside the project.');
  return path;
}
export function readStartup(root: string) {
  const config = startupSchema.parse(
    JSON.parse(read(join(root, 'timemachine/start.json'))),
  );
  projectPath(root, config.entrypoint);
  projectPath(root, config.envFile);
  return config;
}
export function startupEnvironment(
  root: string,
  env: NodeJS.ProcessEnv,
  config?: ReturnType<typeof readStartup>,
) {
  const path = projectPath(root, config?.envFile ?? 'timemachine/.env');
  return {
    ...(existsSync(path) ? parseEnv(read(path)) : {}),
    ...projectEnvironment(root),
    ...env,
  };
}
export function savedNodeArgs(root: string, development: boolean) {
  const config = readStartup(root);
  const entry = projectPath(root, config.entrypoint);
  if (!existsSync(entry) || !statSync(entry).isFile())
    throw new Error(
      'Saved backend entrypoint is missing. Update timemachine/start.json or build your app.',
    );
  return {
    args: [...(development ? ['--watch'] : []), ...config.nodeArgs, entry],
    env: startupEnvironment(root, process.env, config),
  };
}

/** Add a dedicated script only; never replace a developer's dev/start commands. */
export function addStartupScript(root: string) {
  const path = join(root, 'package.json');
  const original = read(path);
  const pkg = JSON.parse(original);
  if (
    !pkg ||
    typeof pkg !== 'object' ||
    Array.isArray(pkg) ||
    (pkg.scripts !== undefined &&
      (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)))
  )
    throw new Error('Invalid package.json scripts.');
  if (Object.hasOwn(pkg.scripts ?? {}, 'dev:timemachine'))
    throw new Error('dev:timemachine already exists; it was not changed.');
  pkg.scripts = { ...pkg.scripts, 'dev:timemachine': 'timemachine dev' };
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}
