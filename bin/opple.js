#!/usr/bin/env node
// opple-cli 入口
import { run } from '../src/cli.js';

run(process.argv.slice(2)).catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
