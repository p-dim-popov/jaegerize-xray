#!/usr/bin/env node
/**
 * jxr — fetch AWS X-Ray traces by ID and emit Jaeger UI JSON on stdout.
 *
 *   jxr 0320dc04049a0152a82d546034008746
 *   jxr 1-58406520-a006649127e371903a2de979 0320dc04049a0152a82d546034008746
 *   jxr <id> > trace.json        # then load via Jaeger UI > Search > JSON File
 *
 * Trace IDs may be Jaeger 32-char hex (as shown in the Jaeger UI) or native
 * X-Ray form; both are accepted. Auth/region come from the standard AWS chain
 * (env vars, ~/.aws, SSO, instance role). Override region with --region or
 * AWS_REGION. Progress goes to stderr so stdout stays clean JSON.
 */
import { normalizeToXray, toJaegerDoc } from "./convert.js";
import { makeClient, fetchTraces } from "./xray.js";
import { openInJaeger, runDaemon, stopBrowser } from "./open.js";

const DEFAULT_UI = "https://demo.jaegertracing.io/jaeger";

const USAGE = `Usage: jxr <traceId...> [--region <aws-region>] [--open] [--ui <jaeger-url>]

  traceId   One or more trace IDs (Jaeger 32-char hex or X-Ray 1-xxxx-yyyy).
  --region  AWS region (default: $AWS_REGION or us-east-1).
  --open    Open the trace in a browser by dropping it into the Jaeger UI.
  --ui      Base URL of the Jaeger UI (default: ${DEFAULT_UI}).
            The upload is parsed client-side, so a hosted UI renders local
            traces without sending them to its backend. Use your own, e.g.
            http://localhost:16686.
  --detach  With --open, return the terminal immediately (default: true).
            Pass --detach false to block until you close the trace tab or
            press Ctrl+C.
  --stop    Close the shared browser and exit.

Repeated --open runs reuse one background browser, opening each trace in a new
tab. Close that browser (or run "jxr --stop") to quit it.

Without --open, emits Jaeger UI JSON on stdout:
  jxr 0320dc04049a0152a82d546034008746 > trace.json

With --open, launches a browser and loads the trace for you:
  jxr 0320dc04049a0152a82d546034008746 --open`;

interface Args {
  help?: boolean;
  ids: string[];
  region?: string;
  open?: boolean;
  ui?: string;
  detach: boolean;
  stop?: boolean;
  daemon?: boolean;
}

function parseArgs(argv: string[]): Args {
  const ids: string[] = [];
  let region: string | undefined;
  let open = false;
  let ui = DEFAULT_UI;
  let detach = true;
  let stop = false;
  let daemon = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return { help: true, ids: [], detach };
    else if (arg === "--region") region = argv[++i];
    else if (arg === "--open") open = true;
    else if (arg === "--ui") ui = argv[++i] ?? ui;
    else if (arg === "--detach") {
      const next = argv[i + 1];
      if (next === "true" || next === "false") {
        detach = next === "true";
        i++;
      } else detach = true;
    } else if (arg === "--stop") stop = true;
    else if (arg === "--__daemon") daemon = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else ids.push(arg);
  }
  return { ids, region, open, ui, detach, stop, daemon };
}

async function main(): Promise<void> {
  const { help, ids, region, open, ui, detach, stop, daemon } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
    return;
  }

  // Internal: run the persistent browser daemon.
  if (daemon) {
    await runDaemon();
    return;
  }

  if (stop) {
    const wasRunning = await stopBrowser();
    console.error(wasRunning ? "Closed the shared browser." : "No shared browser was running.");
    return;
  }

  if (!ids.length) {
    console.error(USAGE);
    process.exit(2);
  }

  const xrayIds = ids.map(normalizeToXray);
  console.error(`Fetching ${xrayIds.length} trace(s) from X-Ray...`);

  const client = makeClient(region);
  const traces = await fetchTraces(client, xrayIds);

  if (!traces.length) console.error("No traces found for the given ID(s).");
  else console.error(`Fetched ${traces.length} trace(s).`);

  const doc = toJaegerDoc(traces);
  if (open) {
    if (!doc.data.length) {
      console.error("Nothing to open: no traces were returned. Check the ID, --region, and AWS credentials.");
      process.exit(1);
    }
    await openInJaeger(ui ?? DEFAULT_UI, doc, { detach });
  } else {
    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
