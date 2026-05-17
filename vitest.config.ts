import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["agent/**/*.test.ts", "lib/**/*.test.ts"],
    passWithNoTests: true,
  },
});
