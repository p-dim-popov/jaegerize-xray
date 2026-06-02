/**
 * `--open` orchestration. One persistent browser is run as a background daemon;
 * every `jxr --open` connects to it over CDP and opens the trace in a new tab,
 * so repeated runs reuse a single browser window instead of spawning a fresh
 * app each time. Closing that browser quits everything. Playwright is
 * lazy-imported so the core CLI works without it.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JaegerDoc } from "./convert.js";

// The daemon re-enters the CLI; resolve it relative to this module so it works
// regardless of how/where open.js was imported from.
const cliEntry = fileURLToPath(new URL("./cli.js", import.meta.url));

const stateDir = join(homedir(), ".cache", "jaegerize-xray");
const userDataDir = join(stateDir, "profile");
const endpointFile = join(stateDir, "cdp-endpoint");
const pidFile = join(stateDir, "daemon.pid");
const lockDir = join(stateDir, "daemon.lock");
const daemonLog = join(stateDir, "daemon.log");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Chromium = typeof import("playwright").chromium;

async function loadChromium(): Promise<Chromium> {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch {
    throw new Error(
      "--open needs Playwright. Install it:\n" +
        "  npm i -g playwright && npx playwright install chromium"
    );
  }
}

function readEndpoint(): string | null {
  try {
    const ep = readFileSync(endpointFile, "utf8").trim();
    return ep || null;
  } catch {
    return null;
  }
}

async function connectable(chromium: Chromium, endpoint: string): Promise<boolean> {
  try {
    const b = await chromium.connectOverCDP(endpoint, { timeout: 2000 });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

/** Spawn the detached browser daemon (this CLI re-entered with --__daemon). */
function spawnDaemon(): void {
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(daemonLog, "a");
  const child = spawn(process.execPath, [cliEntry, "--__daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
}

/** Return a live CDP endpoint, starting the daemon if needed. */
async function ensureEndpoint(chromium: Chromium): Promise<string> {
  const existing = readEndpoint();
  if (existing && (await connectable(chromium, existing))) return existing;

  mkdirSync(stateDir, { recursive: true });
  let holdsLock = false;
  try {
    mkdirSync(lockDir); // atomic: throws if another run is already starting one
    holdsLock = true;
  } catch {
    /* someone else is starting the daemon — just wait for it below */
  }
  if (holdsLock) {
    try {
      unlinkSync(endpointFile); // drop any stale endpoint
    } catch {
      /* none */
    }
    spawnDaemon();
  }

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ep = readEndpoint();
      if (ep && (await connectable(chromium, ep))) return ep;
      await sleep(400);
    }
    throw new Error(`Timed out starting the browser daemon. See log: ${daemonLog}`);
  } finally {
    if (holdsLock) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Daemon entrypoint (--__daemon): own a persistent browser exposing a CDP port,
 * publish its endpoint, and stay alive until the browser is closed.
 */
export async function runDaemon(): Promise<void> {
  const chromium = await loadChromium();
  mkdirSync(stateDir, { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: process.env.JXR_HEADLESS === "1",
      args: ["--remote-debugging-port=0"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      throw new Error("Chromium for Playwright is missing. Run:\n  npx playwright install chromium");
    }
    throw err;
  }

  // Chrome writes the chosen port to DevToolsActivePort shortly after launch.
  const portFile = join(userDataDir, "DevToolsActivePort");
  let port = "";
  for (let i = 0; i < 30 && !port; i++) {
    try {
      port = readFileSync(portFile, "utf8").split("\n")[0]!.trim();
    } catch {
      await sleep(100);
    }
  }
  if (!port) throw new Error("Could not read the browser's debugging port.");
  writeFileSync(endpointFile, `http://127.0.0.1:${port}`);
  writeFileSync(pidFile, String(process.pid));
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  const shutdown = () => {
    for (const f of [endpointFile, pidFile]) {
      try {
        unlinkSync(f);
      } catch {
        /* none */
      }
    }
    process.exit(0);
  };
  context.on("close", shutdown); // user closed the browser
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise<never>(() => {}); // stay alive holding the browser
}

/** Connect to the shared browser and open the trace in a new tab. */
export async function openInJaeger(
  uiBase: string,
  doc: JaegerDoc,
  opts: { detach: boolean } = { detach: true }
): Promise<void> {
  const chromium = await loadChromium();
  const endpoint = await ensureEndpoint(chromium);
  const base = uiBase.replace(/\/+$/, "");

  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  // Reuse the daemon's initial blank tab if it's still around, else open one.
  const blank = context.pages().find((p) => p.url() === "about:blank");
  const page = blank ?? (await context.newPage());

  await page.goto(`${base}/search`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Upload" }).click();
  const input = page.locator('input[type="file"]');
  await input.waitFor({ state: "attached" });
  await input.setInputFiles({
    name: "trace.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });

  // Single trace → jump straight to its view (skip the "/trace/..." placeholder).
  const firstId = doc.data[0]?.traceID;
  if (doc.data.length === 1 && firstId) {
    try {
      const link = page.locator(`a[href$="/trace/${firstId}"]`).first();
      await link.waitFor({ state: "visible", timeout: 6000 });
      await link.click();
    } catch {
      /* leave on the results list */
    }
  }
  await page.bringToFront();
  console.error(`Loaded ${doc.data.length} trace(s) into the Jaeger UI.`);

  if (opts.detach) {
    await browser.close(); // disconnect; the tab stays open in the shared browser
    return;
  }
  console.error("Attached: close the trace tab (or press Ctrl+C) to exit.");
  await new Promise<void>((resolve) => {
    page.on("close", () => resolve());
    process.on("SIGINT", () => resolve());
  });
  await browser.close();
}

/** Stop the shared browser by signalling the daemon that owns it. */
export async function stopBrowser(): Promise<boolean> {
  let pid = 0;
  try {
    pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  } catch {
    /* no pidfile */
  }
  let killed = false;
  if (pid > 0) {
    try {
      process.kill(pid, "SIGTERM"); // daemon's handler closes the browser and exits
      killed = true;
    } catch {
      /* already gone */
    }
  }
  for (const f of [endpointFile, pidFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* none */
    }
  }
  return killed;
}
