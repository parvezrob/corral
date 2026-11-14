// Generated from lib/host.js by scripts/build.mjs. Edit the source, not this copy.
// Running commands and touching files on the machine a space lives on.
// The app (and so every mod) runs on the computer you sit at; a space can live on
// another machine. Every call here takes that machine (null: this computer).
import { exec, hc, readTextFile, writeTextFile, window } from "herdr";

/**
 * Opens a URL in this computer's browser (where you sit, not the space's machine).
 * @param {string} url
 */
export function openUrl(url) {
  const platform = window()?.platform;
  if (platform === "macos") return exec("open", [url]);
  if (platform === "windows") return exec("cmd", ["/c", "start", "", url]);
  return exec("xdg-open", [url]);
}

/** $0 for our sh -c scripts, so errors read "wb: ..." */
const SCRIPT_NAME = "wb";

/** A command that ran and failed: carries what it printed. */
export class CommandError extends Error {
  /**
   * @param {string} what
   * @param {{ code: number, stdout: string, stderr: string }} result
   */
  constructor(what, result) {
    super(`${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    this.name = "CommandError";
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

/**
 * Runs a POSIX sh script on a machine with positional arguments ($1, $2, ...).
 * Pass values as arguments, never pasted into the script text.
 * @param {string | null} machine
 * @param {string} script
 * @param {string[]} [args]
 * @param {{ cwd?: string, timeout?: number }} [options]
 */
export function sh(machine, script, args = [], options = {}) {
  return exec("sh", ["-c", script, SCRIPT_NAME, ...args], { cwd: options.cwd, on: machine, timeout: options.timeout });
}

/**
 * Like sh, but rejects with a CommandError unless the script exits 0.
 * @param {string | null} machine
 * @param {string} script
 * @param {string[]} [args]
 * @param {{ cwd?: string, timeout?: number, what?: string }} [options]
 */
export async function shOk(machine, script, args = [], options = {}) {
  const r = await sh(machine, script, args, options);
  if (r.code !== 0) throw new CommandError(options.what ?? "command", r);
  return r.stdout;
}

/**
 * Runs a program on a machine; rejects with a CommandError unless it exits 0.
 * @param {string | null} machine
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeout?: number }} [options]
 */
export async function run(machine, command, args, options = {}) {
  const r = await exec(command, args, { cwd: options.cwd, on: machine, timeout: options.timeout });
  if (r.code !== 0) throw new CommandError(command, r);
  return r.stdout;
}

/**
 * Reads a UTF-8 file (up to 1 MiB) here or on a machine; null when it's absent.
 * @param {string | null} machine
 * @param {string} path
 */
export function readFile(machine, path) {
  return readTextFile(path, { on: machine });
}

/** The file changed since it was read: someone (an agent?) wrote it meanwhile. */
export class StaleFileError extends Error {
  /** @param {string} path */
  constructor(path) {
    super(`${path} changed since it was opened`);
    this.name = "StaleFileError";
  }
}

/**
 * Writes a UTF-8 file only if it still holds `expected` (null: it must not exist
 * yet), so a save never silently overwrites an agent's edit.
 * Here: Herdr's atomic compare-and-swap write. On another machine: compare, then
 * `hc file write --on`, which streams the text over herdr-core. The compare and
 * the write are two steps there; the window between them is a round trip.
 * @param {string | null} machine
 * @param {string} path
 * @param {string} text
 * @param {string | null} expected
 */
export async function writeFile(machine, path, text, expected) {
  if (!machine) {
    try {
      await writeTextFile(path, text, expected);
    } catch (e) {
      throw /stale|changed|match/i.test(String(e)) ? new StaleFileError(path) : e;
    }
    return;
  }
  const current = await readTextFile(path, { on: machine });
  if (current !== expected) throw new StaleFileError(path);
  // The text travels as an argument to a local sh, which pipes it to hc.
  const r = await exec("sh", ["-c", 'printf %s "$1" | hc file write --on "$2" "$3"', SCRIPT_NAME, text, machine, path], {});
  if (r.code !== 0) throw new CommandError("hc file write", r);
}

/**
 * hc with --json, parsed; rejects on a non-zero exit.
 * @param {string[]} args
 */
export async function hcJson(args) {
  const r = await hc([...args, "--json"]);
  if (r.code !== 0) throw new CommandError(`hc ${args[0]}`, r);
  return JSON.parse(r.stdout || "null");
}
