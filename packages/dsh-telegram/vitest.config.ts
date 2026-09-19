import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The client half is compiled by esbuild in the real build; match its JSX
  // mode here so a component test exercises the same output.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
})
