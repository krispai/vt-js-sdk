import { defineConfig, configDefaults } from "vitest/config";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
);

export default defineConfig({
  define: { __SDK_VERSION__: JSON.stringify(pkg.version) },
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/capture-worklet-source.ts",
        "src/index.ts",
      ],
      thresholds: {
        autoUpdate: true,
        statements: 80.99,
        branches: 72.27,
        functions: 82.92,
        lines: 81.14,
      },
    },
  },
});
