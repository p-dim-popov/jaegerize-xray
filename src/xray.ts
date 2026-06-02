/**
 * Thin wrapper over the AWS X-Ray SDK: fetch full trace data by ID.
 */
import { XRayClient, BatchGetTracesCommand } from "@aws-sdk/client-xray";
import type { XRayTrace } from "./convert.js";

const chunk = <T>(arr: T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export function makeClient(region?: string): XRayClient {
  // When --region isn't passed, let the AWS SDK resolve it from the standard
  // chain: AWS_REGION / AWS_DEFAULT_REGION, then the active profile's region in
  // ~/.aws/config. Forcing a fallback here would bypass that profile lookup.
  return new XRayClient(region ? { region } : {});
}

// traceIds must be in X-Ray form (1-xxxxxxxx-yyyy...). Returns raw X-Ray traces.
export async function fetchTraces(client: XRayClient, traceIds: string[]): Promise<XRayTrace[]> {
  const traces: XRayTrace[] = [];
  for (const group of chunk(traceIds, 5)) {
    // BatchGetTraces accepts max 5 IDs per call.
    let NextToken: string | undefined;
    do {
      const out = await client.send(new BatchGetTracesCommand({ TraceIds: group, NextToken }));
      for (const t of out.Traces ?? []) traces.push(t as XRayTrace);
      NextToken = out.NextToken;
    } while (NextToken);
  }
  return traces;
}

export { chunk };
