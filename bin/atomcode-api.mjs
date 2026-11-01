#!/usr/bin/env node

import { CliError, runCli } from "../src/cli.mjs";

try {
  await runCli(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`atomcode-api: ${error instanceof CliError ? error.message : error.message}\n`);
  process.exitCode = 1;
}
