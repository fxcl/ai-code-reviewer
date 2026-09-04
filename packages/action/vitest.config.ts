import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@acr/pi-agent/review': path.resolve(dirname, '../pi-agent/src/review/index.ts'),
      '@acr/pi-agent': path.resolve(dirname, '../pi-agent/src/index.ts'),
      '@acr/pi-session': path.resolve(dirname, '../pi-session/src/index.ts'),
      '@acr/pi-tools': path.resolve(dirname, '../pi-tools/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/main.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
