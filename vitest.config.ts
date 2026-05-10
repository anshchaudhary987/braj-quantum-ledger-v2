import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Timeout for individual tests
    testTimeout: 10000,
    // Global test setup
    setupFiles: ["./tests/setup.ts"],
    // Coverage
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "tests/",
        "**/*.test.ts",
      ],
    },
    // File patterns
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
  resolve: {
    // Match tsconfig paths
    alias: {
      "@": "/src",
      "@api": "/src/api",
      "@db": "/src/db",
      "@services": "/src/services",
      "@models": "/src/models",
    },
  },
});
