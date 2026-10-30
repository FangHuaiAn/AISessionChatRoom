#!/usr/bin/env node
import { runCli } from "./commands.ts";
try {
  await runCli(process.argv.slice(2), process.env, (value) =>
    process.stdout.write(JSON.stringify(value) + "\n"),
  );
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error: error instanceof Error ? error.message : "Command failed",
    }) + "\n",
  );
  process.exitCode = 1;
}
