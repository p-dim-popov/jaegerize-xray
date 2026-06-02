#!/usr/bin/env node
/**
 * caj — fetch AWS X-Ray traces by ID and emit Jaeger UI JSON on stdout.
 *
 *   caj 0320dc04049a0152a82d546034008746
 *   caj 1-58406520-a006649127e371903a2de979 0320dc04049a0152a82d546034008746
 *   caj <id> > trace.json        # then load via Jaeger UI > Search > JSON File
 *
 * Trace IDs may be Jaeger 32-char hex (as shown in the Jaeger UI) or native
 * X-Ray form; both are accepted. Auth/region come from the standard AWS chain
 * (env vars, ~/.aws, SSO, instance role). Override region with --region or
 * AWS_REGION. Progress goes to stderr so stdout stays clean JSON.
 */
import { normalizeToXray, toJaegerDoc } from "./convert.js";
import { makeClient, fetchTraces } from "./xray.js";

const USAGE = `Usage: caj <traceId...> [--region <aws-region>]

  traceId   One or more trace IDs (Jaeger 32-char hex or X-Ray 1-xxxx-yyyy).
  --region  AWS region (default: $AWS_REGION or us-east-1).

Emits Jaeger UI JSON on stdout. Example:
  caj 0320dc04049a0152a82d546034008746 > trace.json`;

interface Args {
  help?: boolean;
  ids: string[];
  region?: string;
}

function parseArgs(argv: string[]): Args {
  const ids: string[] = [];
  let region: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") return { help: true, ids: [] };
    else if (arg === "--region") region = argv[++i];
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else ids.push(arg);
  }
  return { ids, region };
}

async function main(): Promise<void> {
  const { help, ids, region } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(USAGE);
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

  process.stdout.write(JSON.stringify(toJaegerDoc(traces), null, 2) + "\n");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
