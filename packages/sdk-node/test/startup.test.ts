import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { initializeProject } from '../src/setup-cli.js';
import {
  addStartupScript,
  readStartup,
  savedNodeArgs,
  startupEnvironment,
} from '../src/startup.js';

it('loads saved entrypoint and private env with external environment taking precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-start-'));
  try {
    initializeProject(root, 'my-api', 'index.js');
    writeFileSync(join(root, 'index.js'), '// no server started');
    writeFileSync(
      join(root, 'timemachine/.env'),
      'TIMEMACHINE_AUTH_TOKEN=private\nPORT=4322\n',
    );
    expect(startupEnvironment(root, { PORT: '9000' }, readStartup(root))).toMatchObject({
      PORT: '9000',
      TIMEMACHINE_AUTH_TOKEN: 'private',
    });
    expect(savedNodeArgs(root, false).args).toEqual([join(root, 'index.js')]);
    expect(savedNodeArgs(root, true).args).toEqual(['--watch', join(root, 'index.js')]);
    writeFileSync(
      join(root, 'timemachine/start.json'),
      JSON.stringify({ version: 1, entrypoint: '../outside.js' }),
    );
    expect(() => readStartup(root)).toThrow('inside the project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('preserves dev, start and concurrently scripts when adding its dedicated npm script', () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-script-'));
  try {
    const pkg = {
      name: 'app',
      scripts: {
        dev: 'concurrently "npm run frontend" "nodemon index.js"',
        start: 'node index.js',
      },
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
    addStartupScript(root);
    const updated = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(updated.scripts).toEqual({
      ...pkg.scripts,
      'dev:timemachine': 'timemachine dev',
    });
    const before = readFileSync(join(root, 'package.json'), 'utf8');
    expect(() => addStartupScript(root)).toThrow('already exists');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('fails clearly for missing entrypoints and malformed startup files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-start-'));
  try {
    initializeProject(root, 'my-api', 'dist/server.js');
    expect(() => savedNodeArgs(root, false)).toThrow('entrypoint is missing');
    writeFileSync(join(root, 'timemachine/start.json'), '{invalid');
    expect(() => readStartup(root)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
