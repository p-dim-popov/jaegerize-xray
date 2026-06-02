/**
 * `--open` orchestration: launch a browser, navigate to a Jaeger UI, and drop
 * the converted trace JSON straight into the Upload dropzone — no manual
 * drag-and-drop. Uses Playwright, lazy-imported so the core CLI works without it.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JaegerDoc } from "./convert.js";

// A persistent profile so any SSO/login in front of the Jaeger UI is done once
// and reused on later runs.
const profileDir = join(homedir(), ".cache", "cheap-aws-jaeger", "browser");

export async function openInJaeger(uiBase: string, doc: JaegerDoc): Promise<void> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "--open needs Playwright. Install it:\n" +
        "  npm i -g playwright && npx playwright install chromium"
    );
  }

  const base = uiBase.replace(/\/+$/, "");
  const searchUrl = `${base}/search`;
  mkdirSync(profileDir, { recursive: true });

  console.error(`Launching browser at ${searchUrl} ...`);
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Executable doesn't exist|playwright install/i.test(msg)) {
      throw new Error("Chromium for Playwright is missing. Run:\n  npx playwright install chromium");
    }
    throw err;
  }

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

  // Reveal the dropzone (Jaeger's "Upload" tab), then hand the file to its input.
  await page.getByRole("tab", { name: "Upload" }).click();
  const input = page.locator('input[type="file"]');
  await input.waitFor({ state: "attached" });
  await input.setInputFiles({
    name: "trace.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(doc)),
  });
  console.error(`Loaded ${doc.data.length} trace(s) into the Jaeger UI.`);

  // If there's exactly one trace, jump straight to its view. Target the exact
  // id (the results list also has a "/trace/..." placeholder link) and match on
  // href suffix so it works under a base path (e.g. /jaeger/trace/<id>).
  const firstId = doc.data[0]?.traceID;
  if (doc.data.length === 1 && firstId) {
    try {
      const link = page.locator(`a[href$="/trace/${firstId}"]`).first();
      await link.waitFor({ state: "visible", timeout: 6000 });
      await link.click();
    } catch {
      // Couldn't auto-open — leave the user on the results list.
    }
  }

  console.error("Browser is open. Press Ctrl+C here to close it.");
  process.on("SIGINT", () => {
    void context.close().finally(() => process.exit(0));
  });
  await new Promise<never>(() => {}); // keep the process (and window) alive
}
