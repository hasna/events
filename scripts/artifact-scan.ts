// Pack this repo the way `npm publish` would, then scan what actually shipped.
//
// `contracts artifact-scan` takes a PACKED .tgz — running it against `src/` is
// explicitly wrong, and running it with no target at all just exits 1 and takes
// `npm pack` / `bun publish` down with it. So this script produces the tarball
// first and hands the real artifact to the scanner.
//
// Packing uses `--ignore-scripts`: without it, packing from inside `prepack`
// would re-enter `prepack` forever.
//
// The scanner comes from the pinned `@hasna/contracts` devDependency
// (node_modules/.bin), never `bunx` — an unpinned package runner makes the
// release gate depend on whatever the registry serves that day.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${command.join(" ")} exited ${result.exitCode}\n${stdout}\n${stderr}`);
  }
  return stdout;
}

const repoRoot = join(import.meta.dir, "..");
const scanner = join(repoRoot, "node_modules", ".bin", "contracts");
const workspace = mkdtempSync(join(tmpdir(), "events-artifact-scan-"));

try {
  const packed = run(["bun", "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet"], repoRoot);
  const archive = isAbsolute(packed) ? packed : join(workspace, packed);
  // The manifest is where a reviewed waiver would be declared, so the scanner
  // has to read it; a waiver the enforcement never loads is a dead end.
  const scan = Bun.spawnSync([scanner, "artifact-scan", archive, "--manifest", join(repoRoot, "hasna.contract.json")], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (scan.exitCode !== 0) {
    console.error("\nA published artifact must not carry a bulk asset inventory.");
    process.exit(scan.exitCode ?? 1);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
