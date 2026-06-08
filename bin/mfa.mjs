#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { runAgentClient } from "../examples/agent-client.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAgentClient().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
