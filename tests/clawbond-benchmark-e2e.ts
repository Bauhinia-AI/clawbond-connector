import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClawBondCommands } from "../src/clawbond-commands.ts";
import { createClawBondTools } from "../src/clawbond-tools.ts";

async function main() {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "clawbond-benchmark-e2e-"));
  const seen: Array<{ method: string; pathname: string; body?: unknown }> = [];
  let latestRun = {
    id: "run-1",
    status: "created",
    algorithm_version: "alg-1",
    scores: {
      learning_growth: 0.81,
      tool_usage: 0.9
    }
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    let body: unknown = undefined;

    if (method !== "GET") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }

      if (chunks.length > 0) {
        body = JSON.parse(Buffer.concat(chunks).toString());
      }
    }

    seen.push({ method, pathname, body });

    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: status, data, message: "ok" }));
    };

    assert.equal(req.headers.authorization, "Bearer agent_jwt_test");

    if (pathname === "/api/benchmark/agents/me/latest" && method === "GET") {
      send(200, latestRun);
      return;
    }

    if (pathname === "/api/benchmark/users/me/latest" && method === "GET") {
      send(200, {
        id: "user-run-1",
        status: "finalized",
        algorithm_version: "alg-user-1",
        scores: {
          social_interaction: 0.72
        }
      });
      return;
    }

    if (pathname === "/api/benchmark/runs" && method === "POST") {
      assert.deepEqual(body, {
        counts: {
          learning_growth: 1,
          tool_usage: 2
        }
      });
      send(201, {
        id: "run-1",
        status: "created",
        algorithm_version: "alg-1",
        cases: [
          { id: "case-1", dimension: "learning_growth" },
          { id: "case-2", dimension: "tool_usage" }
        ]
      });
      return;
    }

    if (pathname === "/api/benchmark/runs/run-1" && method === "GET") {
      send(200, {
        id: "run-1",
        status: "created",
        algorithm_version: "alg-1"
      });
      return;
    }

    if (pathname === "/api/benchmark/runs/run-1/cases" && method === "GET") {
      send(200, [
        { id: "case-1", dimension: "learning_growth" },
        { id: "case-2", dimension: "tool_usage" }
      ]);
      return;
    }

    if (pathname === "/api/benchmark/runs/run-1/artifacts" && method === "POST") {
      assert.deepEqual(body, {
        artifacts: [
          {
            case_id: "case-1",
            artifact_type: "submission",
            payload: { focus_ids: ["obs-1"] }
          }
        ]
      });
      send(201, {
        accepted: 1
      });
      return;
    }

    if (pathname === "/api/benchmark/runs/run-1/finalize" && method === "POST") {
      latestRun = {
        id: "run-1",
        status: "finalized",
        algorithm_version: "alg-1",
        scores: {
          learning_growth: 0.88,
          tool_usage: 0.91
        }
      };
      send(200, {
        id: "run-1",
        status: "finalized"
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 404, data: null, message: "not found" }));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve benchmark test server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cfg = {
    channels: {
      clawbond: {
        enabled: true,
        serverUrl: baseUrl,
        apiBaseUrl: baseUrl,
        benchmarkBaseUrl: baseUrl,
        stateRoot,
        runtimeToken: "agent_jwt_test",
        agentId: "agent-local",
        agentName: "Bench Agent",
        secretKey: "secret-test",
        bindingStatus: "bound"
      }
    }
  };

  try {
    const tools = createClawBondTools({
      config: cfg,
      senderIsOwner: true,
      agentAccountId: "default",
      sessionKey: "agent:main:main"
    });
    const benchmarkTool = requireTool(tools, "clawbond_benchmark");

    const latestResult = await benchmarkTool.execute("bench-1", {
      action: "latest"
    });
    assert.equal(latestResult.details["latest"]["id"], "run-1");

    const latestUserResult = await benchmarkTool.execute("bench-2", {
      action: "latest_user"
    });
    assert.equal(latestUserResult.details["latest"]["id"], "user-run-1");

    const createRunResult = await benchmarkTool.execute("bench-3", {
      action: "create_run",
      counts: {
        learning_growth: 1,
        tool_usage: 2
      }
    });
    assert.equal(createRunResult.details["created"]["id"], "run-1");

    const runResult = await benchmarkTool.execute("bench-4", {
      action: "run",
      runId: "run-1"
    });
    assert.equal(runResult.details["run"]["status"], "created");

    const casesResult = await benchmarkTool.execute("bench-5", {
      action: "cases",
      runId: "run-1"
    });
    assert.equal(casesResult.details["cases"][0]["dimension"], "learning_growth");

    const uploadResult = await benchmarkTool.execute("bench-6", {
      action: "upload_artifacts",
      runId: "run-1",
      artifacts: [
        {
          caseId: "case-1",
          payload: {
            focus_ids: ["obs-1"]
          }
        }
      ]
    });
    assert.equal(uploadResult.details["uploaded"]["accepted"], 1);

    const finalizeResult = await benchmarkTool.execute("bench-7", {
      action: "finalize",
      runId: "run-1"
    });
    assert.equal(finalizeResult.details["finalized"]["status"], "finalized");
    assert.equal(finalizeResult.details["latest"]["scores"]["tool_usage"], 0.91);

    const commands = createClawBondCommands({ config: cfg });
    const rootCommand = commands.find((entry) => entry.name === "clawbond");
    const benchmarkCommand = commands.find((entry) => entry.name === "clawbond-benchmark");
    assert.ok(rootCommand);
    assert.ok(benchmarkCommand);

    const rootHelp = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond",
      config: cfg
    } as never);
    assert.match(rootHelp?.text ?? "", /\/clawbond benchmark/);

    const latestCommandResult = await rootCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond benchmark latest",
      args: "benchmark latest",
      config: cfg
    } as never);
    assert.match(latestCommandResult?.text ?? "", /ClawBond benchmark latest/);
    assert.match(latestCommandResult?.text ?? "", /runId: run-1/);

    const casesCommandResult = await benchmarkCommand?.handler({
      channel: "web",
      isAuthorizedSender: true,
      commandBody: "/clawbond-benchmark cases run-1",
      args: "cases run-1",
      config: cfg
    } as never);
    assert.match(casesCommandResult?.text ?? "", /case count: 2/);
    assert.match(casesCommandResult?.text ?? "", /case-1: learning_growth/);

    assert.ok(seen.some((entry) => entry.pathname === "/api/benchmark/agents/me/latest"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/benchmark/users/me/latest"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/benchmark/runs"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/benchmark/runs/run-1"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/benchmark/runs/run-1/cases"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/benchmark/runs/run-1/artifacts"));
    assert.ok(seen.some((entry) => entry.pathname === "/api/benchmark/runs/run-1/finalize"));

    console.log("clawbond-benchmark E2E passed");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await rm(stateRoot, { recursive: true, force: true });
  }
}

function requireTool(
  tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }>,
  name: string
) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`Missing tool ${name}`);
  }

  return tool;
}

await main();
