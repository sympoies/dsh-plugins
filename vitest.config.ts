import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["packages/dsh-telegram/**"],
    coverage: {
      thresholds: {
        statements: 80,
        branches: 60,
        functions: 75,
        lines: 80,
      },
    },
  },
});
