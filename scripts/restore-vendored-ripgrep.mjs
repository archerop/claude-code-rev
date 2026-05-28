#!/usr/bin/env node
/**
 * restore-vendored-ripgrep.mjs
 *
 * Copies ALL available platform ripgrep binaries from:
 *   node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/<triplet>/rg[.exe]
 * to:
 *   src/utils/vendor/ripgrep/<triplet>/rg[.exe]
 *
 * Portability: supports the workflow where `bun install` runs on a macOS host
 * and the restored Claude Code runtime later runs inside a Linux Docker container
 * (e.g. EvoClaw). All platform binaries in node_modules are restored so the
 * correct binary is present regardless of where bun install was run.
 *
 * Hard-fails if:
 *   - The host-platform binary is missing or not executable.
 *   - Either Linux binary (x64-linux or arm64-linux) is missing — these are
 *     required for EvoClaw Docker containers even when bun install ran on macOS.
 *
 * Warns and skips (does not fail) for other optional non-Linux foreign binaries
 * that are absent from node_modules.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function fail(msg) {
  console.error(`[restore-vendored-ripgrep] FATAL: ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`[restore-vendored-ripgrep] WARNING: ${msg}`);
}

function platformName() {
  if (process.platform === "linux") return "linux";
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  fail(`unsupported platform: ${process.platform}`);
}

function archName() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "arm64") return "arm64";
  fail(`unsupported arch: ${process.arch}`);
}

const hostPlatform = platformName();
const hostArch = archName();
const hostTriplet = `${hostArch}-${hostPlatform}`;

// Binaries that must be present after restore regardless of host platform.
// EvoClaw runs inside Linux Docker; both Linux arches are required.
const REQUIRED_TRIPLETS = new Set(["x64-linux", "arm64-linux"]);

const srcVendorRoot = path.join(
  repoRoot,
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
  "vendor",
  "ripgrep",
);

const dstVendorRoot = path.join(repoRoot, "src", "utils", "vendor", "ripgrep");

if (!fs.existsSync(srcVendorRoot)) {
  fail(`source vendor directory not found: ${srcVendorRoot}\nRun bun install first.`);
}

// Enumerate all subdirectories (each is a triplet like x64-linux, arm64-darwin, etc.)
const tripletEntries = fs
  .readdirSync(srcVendorRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory());

if (tripletEntries.length === 0) {
  fail(`no platform directories found under ${srcVendorRoot}`);
}

const restoredTriplets = [];
const missingRequired = [];

for (const entry of tripletEntries) {
  const triplet = entry.name;
  const isWin = triplet.endsWith("win32");
  const binName = isWin ? "rg.exe" : "rg";

  const src = path.join(srcVendorRoot, triplet, binName);
  const dstDir = path.join(dstVendorRoot, triplet);
  const dst = path.join(dstDir, binName);

  if (!fs.existsSync(src)) {
    if (REQUIRED_TRIPLETS.has(triplet)) {
      // Will be reported as a hard failure after the loop.
      missingRequired.push({ triplet, src });
    } else {
      warn(`missing source binary for ${triplet} — skipping: ${src}`);
    }
    continue;
  }

  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(src, dst);

  // Source binaries ship as mode 666 (no execute bit); fix that for non-Windows.
  if (!isWin) {
    fs.chmodSync(dst, 0o755);
  }

  console.log(`[restore-vendored-ripgrep] copied  ${triplet}/${binName}`);
  restoredTriplets.push(triplet);
}

// Hard-fail if any required (Linux) binaries were absent in node_modules.
if (missingRequired.length > 0) {
  for (const { triplet, src } of missingRequired) {
    console.error(`[restore-vendored-ripgrep] FATAL: required binary missing: ${src}`);
  }
  fail(
    `Missing required Linux binaries in node_modules. ` +
    `Ensure @anthropic-ai/claude-agent-sdk includes vendor/ripgrep for all Linux triplets.`,
  );
}

// Hard-fail if the host triplet was not restored (it must be in node_modules).
if (!restoredTriplets.includes(hostTriplet)) {
  fail(
    `host triplet ${hostTriplet} was not restored. ` +
    `Source binary not found at: ${path.join(srcVendorRoot, hostTriplet, hostTriplet.endsWith("win32") ? "rg.exe" : "rg")}`,
  );
}

// Verify the host-platform binary by executing it with --version.
// Foreign binaries (different OS/arch) cannot be executed cross-platform and are skipped.
const hostBinName = hostPlatform === "win32" ? "rg.exe" : "rg";
const hostDst = path.join(dstVendorRoot, hostTriplet, hostBinName);

try {
  const version = execFileSync(hostDst, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  console.log(`[restore-vendored-ripgrep] verified ${hostTriplet}/${hostBinName}: ${version.split("\n")[0]}`);
} catch (err) {
  fail(`restored host binary at ${hostDst} failed --version check: ${err.message}`);
}

// Log non-host triplets as verified (we can't execute them, but copy succeeded).
for (const triplet of restoredTriplets) {
  if (triplet !== hostTriplet) {
    const isWin = triplet.endsWith("win32");
    const binName = isWin ? "rg.exe" : "rg";
    console.log(`[restore-vendored-ripgrep] present  ${triplet}/${binName} (foreign — skipping --version)`);
  }
}

console.log(
  `[restore-vendored-ripgrep] done. ${restoredTriplets.length} triplet(s) restored: ${restoredTriplets.join(", ")}`,
);
