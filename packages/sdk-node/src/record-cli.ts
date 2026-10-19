#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import {
  readStartup,
  startupEnvironment,
  savedNodeArgs,
  addStartupScript,
} from './startup.js';
import { initializeProject, diagnoseProject } from './setup-cli.js';

const args = process.argv.slice(2);
if (args[0] === 'replay' && args[1] === 'build' && args.length === 2) {
  const child = spawn('timemachine-replay', ['build'], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('error', () => {
    console.error('Install @timemachine/replay alongside the SDK to use replay build.');
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
} else if (args[0] === 'init') {
  try {
    const flags = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      if (
        !['--service', '--entry'].includes(args[i]!) ||
        !args[i + 1] ||
        flags.has(args[i]!)
      )
        throw new Error('Usage: timemachine init --service my-api [--entry index.js]');
      flags.set(args[i]!, args[i + 1]!);
    }
    const entry =
      flags.get('--entry') ??
      ['index.js', 'server.js', 'app.js'].find((path) => existsSync(path)) ??
      'app.js';
    initializeProject(process.cwd(), flags.get('--service') ?? 'node-app', entry);
    console.log(
      'Created timemachine setup files. Follow timemachine/README.md; no credentials or existing app files were changed.',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Initialization failed.');
    process.exitCode = 1;
  }
} else if (args[0] === 'script' && args.length === 1) {
  try {
    addStartupScript(process.cwd());
    console.log(
      'Added dev:timemachine. Run npm run dev:timemachine; existing scripts are preserved.',
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Could not add startup script.',
    );
    process.exitCode = 1;
  }
} else if (args[0] === 'doctor') {
  if (args.length > 2 || (args[1] && args[1] !== '--offline')) {
    console.error('Usage: timemachine doctor [--offline]');
    process.exitCode = 1;
  } else {
    let env = process.env;
    try {
      env = startupEnvironment(
        process.cwd(),
        env,
        existsSync('timemachine/start.json') ? readStartup(process.cwd()) : undefined,
      );
    } catch {
      console.error(
        'Startup configuration, TimeMachine config or private credentials are invalid. Check file permissions.',
      );
      process.exitCode = 1;
    }
    const results = await diagnoseProject(process.cwd(), env, args[1] === '--offline');
    for (const result of results)
      console.log(`[${result.status.toUpperCase()}] ${result.message}`);
    if (results.some((result) => result.status === 'fail')) process.exitCode = 1;
    else if (results.some((result) => result.status === 'warn'))
      console.log(
        'Checks completed with warnings; full replay readiness is not confirmed.',
      );
  }
} else if (args[0] === 'record' || args[0] === 'dev') {
  try {
    let launch: { args: string[]; env: NodeJS.ProcessEnv };
    if (args.length === 1) launch = savedNodeArgs(process.cwd(), args[0] === 'dev');
    else if (
      args[0] === 'record' &&
      args[1] === '--' &&
      args.length >= 4 &&
      ['node', process.execPath].includes(args[2]!)
    )
      launch = { args: args.slice(3), env: process.env };
    else
      throw new Error(
        'Usage: timemachine record | dev | record -- node [Node options] app.js',
      );
    if (launch.env.TIMEMACHINE_REPLAY_ARTIFACT_ID) {
      const params = new URLSearchParams({
        service: launch.env.TIMEMACHINE_SERVICE_NAME ?? 'node-app',
        artifactId: launch.env.TIMEMACHINE_REPLAY_ARTIFACT_ID,
      });
      try {
        const response = await fetch(
          `${launch.env.TIMEMACHINE_COLLECTOR_URL ?? 'http://127.0.0.1:4318'}/v1/replay/readiness?${params}`,
          {
            headers: {
              authorization: `Bearer ${launch.env.TIMEMACHINE_AUTH_TOKEN ?? ''}`,
            },
            redirect: 'error',
            signal: AbortSignal.timeout(3000),
          },
        );
        const readiness = response.ok ? await response.json() : undefined;
        if (
          !readiness ||
          typeof readiness !== 'object' ||
          !('registered' in readiness) ||
          readiness.registered !== true ||
          !('runnerEnabled' in readiness) ||
          readiness.runnerEnabled !== true
        )
          console.warn(
            'Replay readiness not confirmed. Build/register the image and deploy its registry to the collector replay host. Basic capture will continue.',
          );
        else
          console.log(
            'Collector recognizes this replay artifact. Docker execution and business assertions are checked when replay runs.',
          );
      } catch {
        console.warn(
          'Could not check collector replay readiness. Basic capture will continue; run timemachine doctor when the collector is reachable.',
        );
      }
    }
    const preload = fileURLToPath(new URL('./automatic-preload.js', import.meta.url));
    const child = spawn(process.execPath, ['--import', preload, ...launch.args], {
      stdio: 'inherit',
      env: launch.env,
    });
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.on('error', () => {
      process.stderr.write('Could not start the recorded Node application.\n');
      process.exitCode = 1;
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      process.exitCode =
        code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not start backend.');
    process.exitCode = 1;
  }
} else {
  console.error(
    'Usage: timemachine init [--service my-api] [--entry index.js] | script | doctor [--offline] | record | dev | record -- node app.js',
  );
  process.exitCode = 1;
}
