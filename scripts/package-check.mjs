import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = process.cwd(),
  dir = mkdtempSync(join(tmpdir(), 'axc-pack-'));
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });
try {
  run('npm', ['pack', '--pack-destination', dir]);
  const tar = join(
    dir,
    readdirSync(dir).find((x) => x.endsWith('.tgz')),
  );
  for (const version of ['18.3.1', '19.2.0']) {
    const cwd = mkdtempSync(join(dir, `react-${version}-`));
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        dependencies: {
          '@axc/agent-workbench': `file:${tar}`,
          react: version,
          'react-dom': version,
          jsdom: '26.1.0',
          typescript: '5.9.3',
          '@types/react': version.startsWith('18') ? '18.3.28' : '19.2.7',
          '@types/react-dom': version.startsWith('18') ? '18.3.7' : '19.2.3',
        },
      }),
    );
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], cwd);
    copyFileSync(resolve('scripts/installed-smoke.mjs'), join(cwd, 'smoke.mjs'));
    writeFileSync(
      join(cwd, 'consumer.tsx'),
      `import {AgentStudio, StudioProvider, Workbench, SimulationDetail, createHttpClient} from '@axc/agent-workbench';import '@axc/agent-workbench/styles.css';const client=createHttpClient({base:'/api'});export const a=<AgentStudio client={client} sections={['chat','agents']}/>;export const b=<StudioProvider client={client}><Workbench scope={{key:'local'}}/><SimulationDetail scope={{key:'local'}} taskId="1"/></StudioProvider>;`,
    );
    run(
      join(cwd, 'node_modules/.bin/tsc'),
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--jsx',
        'react-jsx',
        '--target',
        'es2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        'consumer.tsx',
      ],
      cwd,
    );
    run('node', ['smoke.mjs'], cwd);
    run('npm', ['ls', 'react', '--depth=0'], cwd);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
