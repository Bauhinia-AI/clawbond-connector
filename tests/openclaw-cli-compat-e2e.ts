import assert from "node:assert/strict";

import { resolveOpenClawSpawnTarget } from "../src/openclaw-cli.ts";

async function main() {
  assert.deepEqual(
    resolveOpenClawSpawnTarget({
      explicitCommand: " /tmp/custom-openclaw ",
      processExecPath: "/opt/node/bin/node",
      processArgv1: "/repo/openclaw/openclaw.mjs"
    }),
    {
      command: "/tmp/custom-openclaw",
      args: []
    }
  );

  assert.deepEqual(
    resolveOpenClawSpawnTarget({
      processExecPath: "/opt/node/bin/node",
      processArgv1: "/repo/openclaw/openclaw.mjs"
    }),
    {
      command: "/opt/node/bin/node",
      args: ["/repo/openclaw/openclaw.mjs"]
    }
  );

  assert.deepEqual(
    resolveOpenClawSpawnTarget({
      processExecPath: "/opt/node/bin/node",
      processArgv1: "/repo/openclaw/dist/entry.js"
    }),
    {
      command: "/opt/node/bin/node",
      args: ["/repo/openclaw/dist/entry.js"]
    }
  );

  assert.deepEqual(
    resolveOpenClawSpawnTarget({
      processExecPath: "/opt/node/bin/node",
      processArgv1: "/repo/some-other-cli/index.js"
    }),
    {
      command: "openclaw",
      args: []
    }
  );

  console.log("openclaw-cli compat passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
