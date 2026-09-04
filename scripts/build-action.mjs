import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist');

await mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(root, 'packages/action/src/main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: path.join(outDir, 'index.js'),
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'info',
});

// The repo root package.json declares "type": "module"; dist is bundled as CJS,
// so pin the module type for everything inside dist/.
await writeFile(path.join(outDir, 'package.json'), '{"type":"commonjs"}\n');
