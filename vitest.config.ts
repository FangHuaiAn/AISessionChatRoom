import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "tests/*.node.test.ts"] },
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
