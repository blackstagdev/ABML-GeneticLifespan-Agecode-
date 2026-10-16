import { defineConfig } from "vitest/config";

// Unit tests only (kept separate from the React Router vite.config.ts).
export default defineConfig({
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
  },
});
