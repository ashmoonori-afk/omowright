import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as omowright from "../src/index.js";
import { restrictToOwner, windowsSystemTool } from "../src/owner-only.js";
import { assertOwnerOnly } from "./fixtures/owner-only.mjs";

const fakePipeBrowser = fileURLToPath(
  new URL("./fixtures/fake-pipe-browser.mjs", import.meta.url),
);

// The owner-only check reads ACLs through PowerShell on Windows, which takes
// seconds on a CI runner, hence the explicit budgets below.
test("resolveCloakProfile creates and reuses a fixed fingerprint seed", { timeout: 60_000 }, async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));

  try {
    const first = await omowright.resolveCloakProfile({
      profileDir,
      randomSeed: () => 31415,
    });
    const second = await omowright.resolveCloakProfile({ profileDir });

    assert.equal(first.fingerprintSeed, 31415);
    assert.deepEqual(second, first);
    assert.deepEqual(first.browserArgs, [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      `--user-data-dir=${profileDir}`,
      "--fingerprint=31415",
      // CloakBrowser ships macOS and Windows fingerprints; every non-macOS host presents as Windows.
      `--fingerprint-platform=${process.platform === "darwin" ? "macos" : "windows"}`,
    ]);

    const metadataPath = path.join(profileDir, ".omowright-cloak.json");
    assert.equal(JSON.parse(readFileSync(metadataPath, "utf8")).fingerprintSeed, 31415);
    await assertOwnerOnly([metadataPath, "file"], [profileDir, "directory"]);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("resolveCloakProfile rejects an explicit seed that changes identity", async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));

  try {
    await omowright.resolveCloakProfile({
      profileDir,
      randomSeed: () => 31415,
    });

    await assert.rejects(
      omowright.resolveCloakProfile({ profileDir, fingerprintSeed: 27182 }),
      /fingerprint seed mismatch/i,
    );
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("buildCloakBrowserArgs rejects every identity override form", () => {
  for (const extraArgs of [
    ["--fingerprint=27182"],
    ["--fingerprint", "27182"],
    ["--fingerprint-platform=windows"],
    ["--user-data-dir=/tmp/other-profile"],
    ["--user-data-dir", "/tmp/other-profile"],
  ]) {
    assert.throws(
      () => omowright.buildCloakBrowserArgs({
        profileDir: "/tmp/profile",
        fingerprintSeed: 31415,
        extraArgs,
      }),
      /override fixed profile identity/i,
    );
  }
});

test("resolveCloakProfile tightens existing metadata permissions", { timeout: 60_000 }, async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-profile-"));
  const metadataPath = path.join(profileDir, ".omowright-cloak.json");

  try {
    writeFileSync(metadataPath, '{"fingerprintSeed":31415}\n', { mode: 0o644 });
    chmodSync(metadataPath, 0o644);

    await omowright.resolveCloakProfile({ profileDir });

    // On Windows the loose starting point is the ACL the file inherited from
    // the temp dir, which grants more than the current user.
    await assertOwnerOnly([metadataPath, "file"]);
  } finally {
    rmSync(profileDir, { recursive: true, force: true });
  }
});

// Contract owner: the anonymous (name-less) connectCloakProfile path never
// touches the named-instance registry (IS-5). The child re-imports src/index.js
// with HOME inside the temp dir so even the default registry root derivation is
// observable; if the anonymous path ever delegated to connectNamed, that child
// would create the registry directories and both assertions below would fail.
// The fake CloakBrowser is the shared pipe fixture as a directly spawnable
// executable: connectCloakProfile always puts its identity flags before
// extraArgs, so the spawned browserPath itself must be the program and treat
// those flags as argv. POSIX runs a shebang wrapper; Windows cannot spawn a
// shebang file, so there the fixture is compiled into a real .exe.
test("anonymous connectCloakProfile creates no registry artifacts", { timeout: 15_000 }, async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), "omowright-cloak-anon-"));
  const profileDir = path.join(homeDir, "cloak-profile");
  const registryRoot = path.join(homeDir, "instances-registry");
  const defaultRegistryRoot = path.join(
    homeDir,
    ".local",
    "share",
    "omowright",
    "instances",
  );
  const fakeBrowserPath = path.join(
    homeDir,
    process.platform === "win32" ? "fake-cloak-browser.exe" : "fake-cloak-browser",
  );
  if (process.platform === "win32") {
    execFileSync("bun", ["build", "--compile", fakePipeBrowser, "--outfile", fakeBrowserPath], { stdio: "ignore" });
  } else {
    writeFileSync(
      fakeBrowserPath,
      `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(fakePipeBrowser).href)});\n`,
    );
    chmodSync(fakeBrowserPath, 0o755);
  }
  const entryPoint = pathToFileURL(
    fileURLToPath(new URL("../src/index.js", import.meta.url)),
  ).href;
  const childPath = path.join(homeDir, "anon-child.mjs");
  writeFileSync(
    childPath,
    [
      `const { connectCloakProfile } = await import(${JSON.stringify(entryPoint)});`,
      `try {`,
      `  const browser = await connectCloakProfile({`,
      `    browserPath: ${JSON.stringify(fakeBrowserPath)},`,
      `    profileDir: ${JSON.stringify(profileDir)},`,
      `    fingerprintSeed: 31415,`,
      `    registryRoot: ${JSON.stringify(registryRoot)},`,
      `  });`,
      `  await browser.close();`,
      `  process.stdout.write("ANON_CONNECT_OK\\n");`,
      `  process.exit(0);`,
      `} catch (error) {`,
      `  console.error(error);`,
      `  process.exit(1);`,
      `}`,
      "",
    ].join("\n"),
  );

  try {
    // Own process group so a wedged child tree can always be reaped without
    // hanging the test runner waiting for held stdio pipes.
    const child = spawn(process.execPath, [childPath], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const killGroup = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const stallGuard = setTimeout(killGroup, 12_000);
    let code;
    try {
      code = await new Promise((resolve) => child.once("close", resolve));
    } finally {
      clearTimeout(stallGuard);
      killGroup();
    }

    assert.equal(code, 0, `anonymous connect child failed:\n${stderr}`);
    assert.match(stdout, /ANON_CONNECT_OK/);
    // The connect really ran: the profile seed metadata was written.
    assert.equal(
      existsSync(path.join(profileDir, ".omowright-cloak.json")),
      true,
    );
    // No registry artifacts anywhere: neither the caller-supplied root nor the
    // default ~/.local/share/omowright/instances under the temp HOME exists.
    assert.equal(existsSync(registryRoot), false);
    assert.equal(existsSync(defaultRegistryRoot), false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

const fakeNamedBrowser = fileURLToPath(
  new URL("./fixtures/fake-named-browser.mjs", import.meta.url),
);

async function startFakeNamedBrowser() {
  const child = spawn(process.execPath, [fakeNamedBrowser], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const webSocketDebuggerUrl = await new Promise((resolve, reject) => {
    let buffered = "";
    child.stderr.on("data", (chunk) => {
      buffered += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
      if (match) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`fake browser exited (${code})`)));
  });
  return {
    child,
    webSocketDebuggerUrl,
    endpoint: webSocketDebuggerUrl
      .replace(/^ws:/, "http:")
      .replace(/\/devtools\/.*$/, ""),
  };
}

test("named cloak launch names a healthy different-profile holder", async () => {
  const registryRoot = mkdtempSync(path.join(tmpdir(), "nir-registry-"));
  const mineDir = mkdtempSync(path.join(tmpdir(), "nir-mine-"));
  const otherDir = mkdtempSync(path.join(tmpdir(), "nir-other-"));
  const fake = await startFakeNamedBrowser();
  try {
    writeFileSync(
      path.join(registryRoot, "holder.json"),
      JSON.stringify({
        version: 2,
        name: "holder",
        pid: process.pid,
        endpoint: fake.endpoint,
        webSocketDebuggerUrl: fake.webSocketDebuggerUrl,
        profileDir: otherDir,
        // Records store a resolved path; this spelling of the same binary must
        // still be recognized as the engine the launch would collide with.
        browserPath: `${path.dirname(process.execPath)}/./${path.basename(process.execPath)}`,
        startedAt: new Date().toISOString(),
      }),
    );
    // A healthy generic named instance without a profileDir must be ignored
    // by the conflict scan, not crash it (path.resolve(null)).
    writeFileSync(
      path.join(registryRoot, "generic.json"),
      JSON.stringify({
        version: 2,
        name: "generic",
        pid: process.pid,
        endpoint: fake.endpoint,
        webSocketDebuggerUrl: fake.webSocketDebuggerUrl,
        profileDir: null,
        browserPath: process.execPath,
        startedAt: new Date().toISOString(),
      }),
    );
    await assert.rejects(
      omowright.connectCloakProfile({
        name: "mine",
        browserPath: process.execPath,
        profileDir: mineDir,
        fingerprintSeed: 12345,
        registryRoot,
        legacyProbeUrl: "http://127.0.0.1:1",
      }),
      (error) =>
        error.message.includes('"holder"') &&
        error.message.includes(`pid ${process.pid}`) &&
        error.message.includes(otherDir),
    );
  } finally {
    fake.child.kill("SIGKILL");
    rmSync(registryRoot, { recursive: true, force: true });
    rmSync(mineDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
});

test("named cloak launch detects an unregistered holder on the legacy port", async () => {
  const registryRoot = mkdtempSync(path.join(tmpdir(), "nir-registry-"));
  const mineDir = mkdtempSync(path.join(tmpdir(), "nir-mine-"));
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const legacyProbeUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await assert.rejects(
      omowright.connectCloakProfile({
        name: "mine",
        browserPath: process.execPath,
        profileDir: mineDir,
        fingerprintSeed: 12345,
        registryRoot,
        legacyProbeUrl,
      }),
      (error) =>
        error.message.includes("unregistered CloakBrowser") &&
        error.message.includes(legacyProbeUrl),
    );
  } finally {
    server.close();
    rmSync(registryRoot, { recursive: true, force: true });
    rmSync(mineDir, { recursive: true, force: true });
  }
});

// Contract owner: the Windows owner-only hardening (security contract). The
// Windows tools run by absolute System32 path, so a cwd another user can write
// cannot substitute them, and every failure throws, so no caller goes on with
// the inherited ACL. Test seam: the platform and the spawner are injected so
// the win32 branch runs off Windows; the ACL that results on a real Windows host
// is asserted by the cloak-profile and instances tests through Get-Acl.
const SID = "S-1-5-21-1-2-3-1001";

function spawner({ whoami = `"host\\me","${SID}"\r\n`, icacls } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push({ file, args });
    if (file.endsWith("whoami.exe")) return { stdout: whoami, stderr: "" };
    if (icacls) throw icacls;
    return { stdout: "", stderr: "" };
  };
  return { calls, run };
}

test("windowsSystemTool resolves under SystemRoot, then windir, then C:\\Windows", () => {
  assert.equal(windowsSystemTool("icacls.exe", { SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\icacls.exe");
  assert.equal(windowsSystemTool("icacls.exe", { windir: "E:\\W" }), "E:\\W\\System32\\icacls.exe");
  assert.equal(windowsSystemTool("icacls.exe", {}), "C:\\Windows\\System32\\icacls.exe");
});

test("restrictToOwner on win32 runs whoami and icacls by absolute path with an owner-only grant", async () => {
  const { calls, run } = spawner();
  await restrictToOwner("C:\\data\\profile", "directory", { platform: "win32", run });
  await restrictToOwner("C:\\data\\profile\\seed.json", "file", { platform: "win32", run });
  for (const { file } of calls) assert.ok(path.win32.isAbsolute(file), `${file} is not an absolute path`);
  assert.deepEqual(
    calls.filter(({ file }) => file === windowsSystemTool("icacls.exe")).map(({ args }) => args),
    [
      ["C:\\data\\profile", "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`, "/Q"],
      ["C:\\data\\profile\\seed.json", "/inheritance:r", "/grant:r", `*${SID}:F`, "/Q"],
    ],
  );
  assert.ok(calls.some(({ file }) => file === windowsSystemTool("whoami.exe")));
});

test("restrictToOwner on win32 fails closed when a tool is missing, fails, or names no SID", async () => {
  const missing = Object.assign(new Error("spawn icacls.exe ENOENT"), { code: "ENOENT" });
  await assert.rejects(restrictToOwner("C:\\p", "file", { platform: "win32", run: spawner({ icacls: missing }).run }), /ENOENT/);
  const exited = Object.assign(new Error("Command failed: icacls.exe"), { code: 5 });
  await assert.rejects(restrictToOwner("C:\\p", "file", { platform: "win32", run: spawner({ icacls: exited }).run }), /Command failed/);
  const noSid = spawner({ whoami: "INFO: no user\r\n" });
  await assert.rejects(restrictToOwner("C:\\p", "file", { platform: "win32", run: noSid.run }), /SID/);
  assert.equal(noSid.calls.some(({ file }) => file.endsWith("icacls.exe")), false);
});
