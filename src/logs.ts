/**
 * Fetch traces from CloudWatch Transaction Search (the `aws/spans` log group)
 * for accounts that send OTLP spans to CloudWatch Logs instead of the legacy
 * X-Ray store. xray:BatchGetTraces returns nothing for those traces; this is
 * the fallback path.
 */
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { normalizeToXray, type OtlpSpan } from "./convert.js";

export const DEFAULT_LOG_GROUP = "aws/spans";

export function makeLogsClient(region?: string): CloudWatchLogsClient {
  // Same standard-chain region resolution as the X-Ray client.
  return new CloudWatchLogsClient(region ? { region } : {});
}

// The first 8 hex chars of a trace ID are the epoch-second creation time.
// Use it to bound the log scan: a few minutes before the trace started, up to
// an hour after (longer than any realistic single trace). Narrowing the window
// keeps FilterLogEvents fast and cheap.
function traceWindowMs(xrayIds: string[]): { start: number; end: number } {
  const startsSec = xrayIds.map((id) => parseInt(id.split("-")[1]!, 16));
  const minStart = Math.min(...startsSec);
  const maxStart = Math.max(...startsSec);
  return { start: (minStart - 5 * 60) * 1000, end: (maxStart + 60 * 60) * 1000 };
}

export interface FetchLogsOptions {
  region?: string;
  logGroup?: string;
}

// Returns one OtlpSpan[] per trace ID that had spans, keyed by Jaeger hex ID.
// Trace IDs may be in either form; the filter matches the 32-char hex the spans
// actually carry. A missing log group (Transaction Search off) throws.
export async function fetchTracesFromLogs(
  ids: string[],
  opts: FetchLogsOptions = {}
): Promise<Map<string, OtlpSpan[]>> {
  const xrayIds = ids.map(normalizeToXray);
  const hexIds = xrayIds.map((id) => id.slice(2).replace(/-/g, ""));
  const { start, end } = traceWindowMs(xrayIds);
  const client = makeLogsClient(opts.region);
  const logGroupName = opts.logGroup ?? DEFAULT_LOG_GROUP;
  const byTrace = new Map<string, OtlpSpan[]>();

  for (const hex of hexIds) {
    let nextToken: string | undefined;
    do {
      const out = await client.send(
        new FilterLogEventsCommand({
          logGroupName,
          startTime: start,
          endTime: end,
          // Quote the ID so it's a literal substring match on the span JSON.
          filterPattern: `"${hex}"`,
          nextToken,
        })
      );
      for (const ev of out.events ?? []) {
        if (!ev.message) continue;
        const span = JSON.parse(ev.message) as OtlpSpan;
        if (span.traceId !== hex) continue; // skip coincidental substring hits
        const list = byTrace.get(hex);
        if (list) list.push(span);
        else byTrace.set(hex, [span]);
      }
      nextToken = out.nextToken;
    } while (nextToken);
  }

  return byTrace;
}
