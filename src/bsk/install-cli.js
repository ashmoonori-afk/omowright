import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { windowsSystemTool } from "../owner-only.js";

const INSTALL_SH = "https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.sh";
const INSTALL_PS1 = "https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1";
const RC_FILES = [".zshrc", ".bashrc", ".profile"];

// A PowerShell 7 parent hands its own module dirs to the Windows PowerShell 5.1
// child through PSModulePath. They shadow 5.1's Microsoft.PowerShell.Utility, so
// Get-FileHash is missing and the installer dies at checksum verification. Keep
// every entry except PowerShell 7's (...\PowerShell\..., never ...\WindowsPowerShell\...).
function windowsPowerShellEnv(env) {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === "PSMODULEPATH");
  if (!key) return env;
  const kept = process.env[key].split(";").filter((entry) => entry && !/[\\/]PowerShell[\\/]/i.test(entry));
  return { ...env, [key]: kept.length > 0 ? kept.join(";") : undefined };
}

export function cliInstallCommand({ platform = process.platform, installDir, version } = {}) {
  const env = { BSK_INSTALL_DIR: installDir };
  if (version) env.BSK_VERSION = version;
  if (platform === "win32") {
    return { command: windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe"), args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${INSTALL_PS1} | iex`], env: windowsPowerShellEnv(env) };
  }
  return { command: "sh", args: ["-c", `curl -fsSL ${INSTALL_SH} | sh`], env };
}

function runDefault(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout = (stdout + c).slice(-8192); });
    child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-8192); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function snapshotRcFiles(home) {
  const snapshot = new Map();
  for (const name of RC_FILES) {
    const file = path.join(home, name);
    snapshot.set(file, existsSync(file) ? readFileSync(file) : null);
  }
  return snapshot;
}

function restoreRcFiles(snapshot) {
  const restored = [];
  for (const [file, before] of snapshot) {
    const after = existsSync(file) ? readFileSync(file) : null;
    if (before === null && after === null) continue;
    if (before !== null && after !== null && before.equals(after)) continue;
    if (before === null) rmSync(file, { force: true }); else writeFileSync(file, before);
    restored.push(file);
  }
  return restored;
}

export async function installBskCli({ platform = process.platform, home = homedir(), installDir = path.join(home, ".local", "bin"), version, run = runDefault } = {}) {
  const spec = cliInstallCommand({ platform, installDir, version });
  const rcBefore = platform === "win32" ? new Map() : snapshotRcFiles(home);
  const result = await run(spec.command, spec.args, spec.env);
  const restoredRcFiles = restoreRcFiles(rcBefore);
  const bskBin = path.join(installDir, platform === "win32" ? "bsk.exe" : "bsk");
  const installed = result.code === 0 && existsSync(bskBin);
  return { installed, bskBin: installed ? bskBin : null, code: result.code, stdout: result.stdout, stderr: result.stderr, restoredRcFiles };
}

export function cliVersionDefault(bskBin) {
  return new Promise((resolve) => {
    const child = spawn(bskBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out.trim() : null));
  });
}
