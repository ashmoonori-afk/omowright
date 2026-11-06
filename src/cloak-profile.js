import { randomInt } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { globSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectNamed, listInstances, withEngineLock } from "./instances.js";
import { restrictToOwner } from "./owner-only.js";
import { connectPipe } from "./pipe.js";

const LEGACY_PROBE_TIMEOUT_MS = 1500;

const MIN_FINGERPRINT_SEED = 10_000;
const MAX_FINGERPRINT_SEED = 99_999;
const METADATA_FILE = ".omowright-cloak.json";
const DEFAULT_PROFILE_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "omowright-cloak",
);

function normalizeFingerprintSeed(value) {
  const seed = typeof value === "string" && value.trim() !== ""
    ? Number(value)
    : value;
  if (
    !Number.isInteger(seed) ||
    seed < MIN_FINGERPRINT_SEED ||
    seed > MAX_FINGERPRINT_SEED
  ) {
    throw new RangeError(
      `fingerprint seed must be an integer from ${MIN_FINGERPRINT_SEED} to ${MAX_FINGERPRINT_SEED}`,
    );
  }
  return seed;
}

function platformFingerprint() {
  return process.platform === "darwin" ? "macos" : "windows";
}

function identityFlag(value) {
  return /^(--user-data-dir|--fingerprint|--fingerprint-platform)(?:=|$)/.test(value);
}

export function buildCloakBrowserArgs({
  profileDir,
  fingerprintSeed,
  extraArgs = [],
} = {}) {
  const profile = path.resolve(profileDir ?? DEFAULT_PROFILE_DIR);
  const seed = normalizeFingerprintSeed(fingerprintSeed);
  const conflicting = extraArgs.filter(identityFlag);
  if (conflicting.length > 0) {
    throw new Error(
      `extraArgs cannot override fixed profile identity: ${conflicting.join(", ")}`,
    );
  }
  return [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    `--user-data-dir=${profile}`,
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${platformFingerprint()}`,
    ...extraArgs,
  ];
}

async function readMetadata(metadataPath) {
  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8"));
    return normalizeFingerprintSeed(parsed.fingerprintSeed);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      throw new Error(`invalid CloakBrowser profile metadata: ${metadataPath}`);
    }
    throw error;
  }
}

async function writeMetadata(metadataPath, fingerprintSeed) {
  const handle = await open(metadataPath, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ fingerprintSeed }, null, 2)}\n`,
      "utf8",
    );
  } finally {
    await handle.close();
  }
  try {
    await restrictToOwner(metadataPath, "file");
  } catch (error) {
    // Fail closed: never leave a fresh seed file under the inherited ACL.
    await unlink(metadataPath).catch(() => {});
    throw error;
  }
}

export async function resolveCloakProfile({
  profileDir = DEFAULT_PROFILE_DIR,
  fingerprintSeed,
  randomSeed = () => randomInt(MIN_FINGERPRINT_SEED, MAX_FINGERPRINT_SEED + 1),
} = {}) {
  const resolvedProfile = path.resolve(profileDir);
  const metadataPath = path.join(resolvedProfile, METADATA_FILE);
  await mkdir(resolvedProfile, { recursive: true, mode: 0o700 });
  await restrictToOwner(resolvedProfile, "directory");

  const requested = fingerprintSeed === undefined
    ? null
    : normalizeFingerprintSeed(fingerprintSeed);
  let stored = await readMetadata(metadataPath);

  if (stored === null) {
    const candidate = requested ?? normalizeFingerprintSeed(randomSeed());
    try {
      await writeMetadata(metadataPath, candidate);
      stored = candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      stored = await readMetadata(metadataPath);
      if (stored === null) {
        throw new Error(`CloakBrowser profile seed metadata disappeared: ${metadataPath}`);
      }
    }
  }

  if (requested !== null && requested !== stored) {
    throw new Error(
      `fingerprint seed mismatch: profile is fixed at ${stored}, requested ${requested}`,
    );
  }

  await restrictToOwner(metadataPath, "file");

  return {
    profileDir: resolvedProfile,
    metadataPath,
    fingerprintSeed: stored,
    browserArgs: buildCloakBrowserArgs({
      profileDir: resolvedProfile,
      fingerprintSeed: stored,
    }),
  };
}

export function findCloakBrowserPath({
  browserRoot = path.join(os.homedir(), ".cloakbrowser"),
} = {}) {
  const candidates = globSync(
    path.join(
      path.resolve(browserRoot),
      "chromium-*",
      "Chromium.app",
      "Contents",
      "MacOS",
      "Chromium",
    ),
  ).sort();
  const browserPath = candidates.at(-1);
  if (!browserPath) {
    throw new Error(
      `CloakBrowser binary not found under ${path.resolve(browserRoot)}; set CLOAKBROWSER_BIN`,
    );
  }
  return browserPath;
}

async function assertCloakLaunchClear({
  browserPath,
  profileDir,
  registryRoot,
  legacyProbeUrl,
  probeTimeoutMs,
}) {
  const records = await listInstances({ registryRoot, probeTimeoutMs });
  for (const record of records) {
    if (!record.alive || !record.responsive) continue;
    if (!record.profileDir) continue;
    if (path.resolve(record.profileDir) === path.resolve(profileDir)) continue;
    // Records store a resolved path; the caller's may be relative or spelled
    // differently, and an unresolved compare would skip the guard.
    if (path.resolve(record.browserPath) !== path.resolve(browserPath)) continue;
    throw new Error(
      `CloakBrowser allows one instance: "${record.name}" (pid ${record.pid}, profile ${record.profileDir}) is live — connectNamed("${record.name}") to reuse it or close it first`,
    );
  }

  // Nothing dials a local port its caller did not name (#80): the legacy
  // probe runs only against an endpoint passed as legacyProbeUrl.
  if (legacyProbeUrl === undefined) return;
  // A registered holder may legitimately answer on the legacy port; only an
  // unregistered engine there blocks a launch.
  const legacyHost = new URL(legacyProbeUrl).host;
  const explainedByRecord = records.some(
    (record) =>
      record.alive && record.responsive && new URL(record.endpoint).host === legacyHost,
  );
  if (explainedByRecord) return;
  try {
    const response = await fetch(new URL("/json/version", legacyProbeUrl), {
      signal: AbortSignal.timeout(probeTimeoutMs ?? LEGACY_PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      throw new Error(
        `an unregistered CloakBrowser is answering on ${legacyProbeUrl} — attach with connect("${legacyProbeUrl}") or close it before launching`,
      );
    }
  } catch (error) {
    const unreachable =
      error instanceof TypeError ||
      error?.name === "TimeoutError" ||
      error?.name === "AbortError";
    if (!unreachable) throw error;
  }
}

export async function connectCloakProfile({
  browserPath = process.env.CLOAKBROWSER_BIN ?? findCloakBrowserPath(),
  profileDir = process.env.CLOAK_PROFILE_DIR ?? DEFAULT_PROFILE_DIR,
  fingerprintSeed = process.env.CLOAK_FINGERPRINT_SEED,
  browserArgs = [],
  storageRoot,
  name,
  ...options
} = {}) {
  const profile = await resolveCloakProfile({ profileDir, fingerprintSeed });
  const resolvedBrowserArgs = buildCloakBrowserArgs({
    profileDir: profile.profileDir,
    fingerprintSeed: profile.fingerprintSeed,
    extraArgs: browserArgs,
  });
  if (name === undefined) {
    return connectPipe({
      browserPath,
      browserArgs: resolvedBrowserArgs,
      storageRoot: storageRoot ?? profile.profileDir,
      ...options,
    });
  }
  const { legacyProbeUrl, ...connectOptions } = options;
  return withEngineLock(connectOptions.registryRoot, browserPath, async () => {
    await assertCloakLaunchClear({
      browserPath,
      profileDir: profile.profileDir,
      registryRoot: connectOptions.registryRoot,
      legacyProbeUrl,
      probeTimeoutMs: connectOptions.probeTimeoutMs,
    });
    return connectNamed(name, {
      browserPath,
      browserArgs: resolvedBrowserArgs,
      profileDir: profile.profileDir,
      storageRoot: storageRoot ?? profile.profileDir,
      ...connectOptions,
    });
  });
}
