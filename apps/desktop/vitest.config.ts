import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/reader/**/*.test.ts"],
    environment: "node",
  },
});
