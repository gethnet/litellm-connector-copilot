/** Resolve the host version without silently guessing an unsupported engine range. */
export function resolveTestVersion(args, environmentVersion, engineRange) {
  if (!args.includes("--minimum-host")) {
    return environmentVersion;
  }

  // The smoke test enforces this repository's ^major.minor.patch engine policy.
  const match = typeof engineRange === "string" && /^\^(\d+\.\d+\.\d+)$/.exec(engineRange);
  if (!match) {
    throw new Error('The --minimum-host flag requires engines.vscode in the form "^major.minor.patch".');
  }
  return match[1];
}