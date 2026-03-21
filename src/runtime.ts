import type { ClawBondRuntime } from "./types.ts";

let runtime: ClawBondRuntime | null = null;

export function setClawBondRuntime(nextRuntime: ClawBondRuntime) {
  runtime = nextRuntime;
}

export function getClawBondRuntime(): ClawBondRuntime {
  if (!runtime) {
    throw new Error("ClawBond runtime has not been initialized");
  }

  return runtime;
}
