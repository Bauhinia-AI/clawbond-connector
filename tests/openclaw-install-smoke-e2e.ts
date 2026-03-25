import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "clawbond-connector";

type CommandResult = {
  stdout: string;
  stderr: string;
};

type OpenClawConfigSnapshot = {
  plugins?: {
    installs?: Record<
      string,
      {
        installPath?: string;
      }
    >;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pluginDir = path.resolve(__dirname, "..");
const WINDOWS_BATCH_COMMAND_RE = /\.(cmd|bat)$/i;

function resolveNpmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function resolveOpenClawPackageSpec(): string {
  return process.env.OPENCLAW_PACKAGE_SPEC?.trim() || "openclaw@latest";
}

async function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const useWindowsCmdWrapper =
      process.platform === "win32" && WINDOWS_BATCH_COMMAND_RE.test(command);
    const child = spawn(
      useWindowsCmdWrapper ? process.env.ComSpec ?? "cmd.exe" : command,
      useWindowsCmdWrapper
        ? ["/d", "/s", "/c", buildWindowsCommandLine(command, args)]
        : args,
      {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(useWindowsCmdWrapper ? { windowsVerbatimArguments: true } : {})
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          [
            `Command failed: ${command} ${args.join(" ")}`,
            stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
            stderr.trim() ? `stderr:\n${stderr.trim()}` : ""
          ]
            .filter(Boolean)
            .join("\n\n")
        )
      );
    });
  });
}

function buildWindowsCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(escapeWindowsCmdArg).join(" ");
}

function escapeWindowsCmdArg(value: string): string {
  if (!value.includes(" ") && !value.includes('"')) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

async function ensureExists(targetPath: string) {
  await access(targetPath);
}

async function packPluginTarball(): Promise<string> {
  const { stdout } = await runCommand(resolveNpmCommand(), ["pack", "--json"], {
    cwd: pluginDir
  });

  const parsed = JSON.parse(stdout) as Array<{ filename?: string }>;
  const filename = parsed[0]?.filename;
  assert.equal(typeof filename, "string", "npm pack did not return a tarball filename");
  const tgzPath = path.join(pluginDir, filename);
  await ensureExists(tgzPath);
  return tgzPath;
}

async function installOpenClawCli(installRoot: string, packageSpec: string) {
  await mkdir(installRoot, { recursive: true });
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await runCommand(
        resolveNpmCommand(),
        ["install", "--prefix", installRoot, "--no-save", "--no-package-lock", packageSpec],
        {
          cwd: pluginDir
        }
      );
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const isRetriable =
        /ECONNRESET|ETIMEDOUT|EAI_AGAIN|network aborted|network timeout/i.test(message);
      if (!isRetriable || attempt === 2) {
        throw error;
      }
      console.warn(`retrying OpenClaw install after transient npm error (${packageSpec})`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function resolveOpenClawBinary(installRoot: string): string {
  const binName = process.platform === "win32" ? "openclaw.cmd" : "openclaw";
  return path.join(installRoot, "node_modules", ".bin", binName);
}

function resolveInstalledPluginPath(config: OpenClawConfigSnapshot): string | null {
  return config.plugins?.installs?.[PLUGIN_ID]?.installPath?.trim() || null;
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "clawbond-openclaw-install-"));
  const simulatedHome = path.join(tempRoot, "home");
  const openclawStateDir = path.join(simulatedHome, ".openclaw");
  const configPath = path.join(openclawStateDir, "openclaw.json");
  const openclawInstallRoot = path.join(tempRoot, "openclaw-cli");
  const openclawPackageSpec = resolveOpenClawPackageSpec();
  const packageJson = JSON.parse(
    await readFile(path.join(pluginDir, "package.json"), "utf8")
  ) as { version?: string };

  await mkdir(openclawStateDir, { recursive: true });
  await writeFile(configPath, "{}\n", "utf8");

  try {
    const pluginTgz = process.env.PLUGIN_TGZ?.trim() || (await packPluginTarball());
    await installOpenClawCli(openclawInstallRoot, openclawPackageSpec);
    const openclawBin = resolveOpenClawBinary(openclawInstallRoot);
    await ensureExists(openclawBin);

    const nodeModulesPath = path.join(openclawInstallRoot, "node_modules");
    const nodeModulesBinPath = path.join(nodeModulesPath, ".bin");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: simulatedHome,
      USERPROFILE: simulatedHome,
      OPENCLAW_HOME: simulatedHome,
      OPENCLAW_STATE_DIR: openclawStateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      PATH: [nodeModulesBinPath, process.env.PATH]
        .filter(Boolean)
        .join(process.platform === "win32" ? ";" : ":"),
      NO_COLOR: "1"
    };

    const versionResult = await runCommand(openclawBin, ["--version"], {
      cwd: pluginDir,
      env
    });
    const versionText = `${versionResult.stdout}${versionResult.stderr}`.trim();
    assert.ok(versionText.length > 0, "failed to execute target OpenClaw CLI");

    const installResult = await runCommand(
      openclawBin,
      ["plugins", "install", pluginTgz],
      {
        cwd: pluginDir,
        env
      }
    );
    const installText = `${installResult.stdout}\n${installResult.stderr}`;
    assert.match(installText, /clawbond-connector/i, "plugin install output did not mention clawbond-connector");

    const infoResult = await runCommand(
      openclawBin,
      ["plugins", "info", PLUGIN_ID],
      {
        cwd: pluginDir,
        env
      }
    );
    const infoText = `${infoResult.stdout}\n${infoResult.stderr}`;
    assert.match(infoText, /clawbond-connector/i, "plugin metadata lookup failed");
    assert.match(infoText, /Status:\s+loaded/i, "installed plugin did not load successfully");
    if (packageJson.version) {
      assert.match(infoText, new RegExp(packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    const configSnapshot = JSON.parse(await readFile(configPath, "utf8")) as OpenClawConfigSnapshot;
    const recordedInstallPath = resolveInstalledPluginPath(configSnapshot);
    const installPath = recordedInstallPath
      ? path.join(recordedInstallPath, "index.ts")
      : path.join(openclawStateDir, "extensions", PLUGIN_ID, "index.ts");
    try {
      await ensureExists(installPath);
    } catch {
      await ensureExists(path.join(simulatedHome, ".openclaw", "extensions", PLUGIN_ID, "index.ts"));
    }

    console.log(`openclaw install smoke passed (${openclawPackageSpec})`);
  } finally {
    if (process.env.OPENCLAW_KEEP_TEMP !== "1") {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
