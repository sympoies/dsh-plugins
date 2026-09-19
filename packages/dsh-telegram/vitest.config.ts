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
      // The browser half is exercised through its built bundle below; keep the
      // host coverage gate scoped to the directly imported TypeScript modules.
      exclude: ['src/client/**'],
      // Vitest 4's AST-aware V8 remapping counts branch and function sites more
      // precisely than the upstream package's Vitest 3 baseline.
      thresholds: { lines: 80, functions: 75, branches: 75, statements: 80 },
    },
  },
})
