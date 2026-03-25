import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import ts from "typescript";

const ROOT = process.cwd();
const TARGET_DIRS = ["src", "tests"];
const STATIC_FILES = ["index.ts"];

async function main() {
  const files = new Set(STATIC_FILES);

  for (const relativeDir of TARGET_DIRS) {
    const absoluteDir = path.join(ROOT, relativeDir);
    for (const file of await collectTypeScriptFiles(absoluteDir)) {
      files.add(path.relative(ROOT, file));
    }
  }

  const rootNames = [...files].sort().map((file) => path.join(ROOT, file));
  const compilerOptions = {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext
  };

  const program = ts.createProgram(rootNames, compilerOptions);
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program
      .getSourceFiles()
      .filter(
        (sourceFile) =>
          !sourceFile.isDeclarationFile &&
          sourceFile.fileName.startsWith(ROOT) &&
          rootNames.includes(sourceFile.fileName)
      )
      .flatMap((sourceFile) => program.getSyntacticDiagnostics(sourceFile))
  ];

  if (diagnostics.length === 0) {
    return;
  }

  const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n"
  });
  process.stderr.write(formatted);
  process.exitCode = 1;
}

async function collectTypeScriptFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!absolutePath.endsWith(".ts") || absolutePath.endsWith(".d.ts")) {
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

await main();
