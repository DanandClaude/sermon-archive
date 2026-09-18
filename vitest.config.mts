import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside a React Server Components build; tests run in plain Node.
      'server-only': new URL('./tests/support/empty.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    globalSetup: ['./tests/support/global-setup.ts'],
    setupFiles: ['./tests/support/setup.ts'],
    // DB tests share one database, so run files one at a time.
    fileParallelism: false,
  },
});
