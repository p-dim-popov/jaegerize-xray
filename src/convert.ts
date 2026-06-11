/**
 * Pure, unit-testable conversion between AWS X-Ray and Jaeger UI trace formats.
 * No AWS calls in this file.
 */

// ---------- X-Ray shapes (only the fields we read) ----------

export interface XRaySegmentDoc {
  id: string;
  name?: string;
  parent_id?: string;
  start_time?: number;
  end_time?: number;
  origin?: string;
  namespace?: string;
  http?: {
    request?: { method?: string; url?: string };
    response?: { status?: number };
  };
  fault?: boolean;
  error?: boolean;
  throttle?: boolean;
  cause?: { exceptions?: Array<{ message?: string }> };
  subsegments?: XRaySegmentDoc[];
}

export interface XRayTrace {
  Id: string;
  Segments?: Array<{ Document: string }>;
}

// ---------- OTLP shapes (CloudWatch Transaction Search `aws/spans`) ----------
// Each log event is one flattened OTLP span. traceId/spanId are already plain
// lowercase hex (no base64), so they map straight onto Jaeger IDs.

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: string;
  startTimeUnixNano?: number;
  endTimeUnixNano?: number;
  durationNano?: number;
  attributes?: Record<string, unknown>;
  status?: { code?: string; message?: string };
  resource?: { attributes?: Record<string, unknown> };
}

// ---------- Jaeger shapes ----------

export interface JaegerTag {
  key: string;
  type: "string" | "bool" | "int64";
  value: string | boolean | number;
}

export interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  references: Array<{ refType: "CHILD_OF"; traceID: string; spanID: string }>;
  startTime: number;
  duration: number;
  tags: JaegerTag[];
  logs: never[];
  processID: string;
  warnings: null;
}

export interface JaegerProcess {
  serviceName: string;
  tags: JaegerTag[];
}

export interface JaegerTraceData {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, JaegerProcess>;
  warnings: null;
}

export interface JaegerDoc {
  data: JaegerTraceData[];
  total: number;
  limit: number;
  offset: number;
  errors: null;
}

// ---------- trace ID conversion ----------

// 1-58406520-a006649127e371903a2de979 -> 58406520a006649127e371903a2de979
export function xrayTraceIdToJaeger(xrayId: string): string {
  const parts = xrayId.split("-");
  if (parts.length === 3) return (parts[1]! + parts[2]!).toLowerCase();
  return xrayId.replace(/-/g, "").toLowerCase();
}

// 58406520a006649127e371903a2de979 -> 1-58406520-a006649127e371903a2de979
export function jaegerTraceIdToXray(jaegerId: string): string {
  const hex = jaegerId.replace(/-/g, "").toLowerCase();
  return `1-${hex.slice(0, 8)}-${hex.slice(8)}`;
}

// Accept either format on input, always return X-Ray's 1-xxxxxxxx-yyyy... form.
export function normalizeToXray(input: string): string {
  const s = String(input).trim();
  if (/^1-[0-9a-f]{8}-[0-9a-f]{24}$/i.test(s)) return s.toLowerCase();
  const hex = s.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex)) return jaegerTraceIdToXray(hex);
  throw new Error(
    `Unrecognized trace ID: "${input}". Expected a 32-char hex Jaeger ID ` +
      `or an X-Ray ID like 1-58406520-a006649127e371903a2de979.`
  );
}

export const toMicros = (epochSeconds: number): number => Math.round(Number(epochSeconds) * 1e6);

// OTLP timestamps are integer nanoseconds. Divide to microseconds for Jaeger.
// The micro value stays < 2^53 for any realistic time, so precision is safe.
export const nanoToMicros = (nanos: number): number => Math.round(Number(nanos) / 1e3);

// ---------- segment -> spans ----------

function flatten(
  doc: XRaySegmentDoc,
  traceId: string,
  serviceName: string,
  parentSpanId: string | undefined,
  spans: JaegerSpan[],
  processes: Record<string, JaegerProcess>
): void {
  const startUs = doc.start_time != null ? toMicros(doc.start_time) : 0;
  const durationUs =
    doc.start_time != null && doc.end_time != null ? toMicros(doc.end_time) - startUs : 0;

  const processID = "p_" + serviceName;
  if (!processes[processID]) processes[processID] = { serviceName, tags: [] };

  const tags: JaegerTag[] = [];
  const addTag = (
    key: string,
    value: unknown,
    type: JaegerTag["type"] = "string"
  ): void => {
    if (value == null) return;
    if (type === "bool") tags.push({ key, type: "bool", value: Boolean(value) });
    else if (type === "int64") tags.push({ key, type: "int64", value: Number(value) });
    else tags.push({ key, type: "string", value: String(value) });
  };

  addTag("xray.origin", doc.origin);
  addTag("xray.namespace", doc.namespace);
  const req = doc.http?.request ?? {};
  const resp = doc.http?.response ?? {};
  addTag("http.method", req.method);
  addTag("http.url", req.url);
  if (resp.status != null) addTag("http.status_code", resp.status, "int64");
  if (doc.fault || doc.error) addTag("error", true, "bool");
  if (doc.throttle) addTag("xray.throttle", true, "bool");
  for (const exc of doc.cause?.exceptions ?? []) addTag("error.message", exc.message);

  const references: JaegerSpan["references"] = parentSpanId
    ? [{ refType: "CHILD_OF", traceID: traceId, spanID: parentSpanId }]
    : [];

  spans.push({
    traceID: traceId,
    spanID: doc.id,
    operationName: doc.name || "unknown",
    references,
    startTime: startUs,
    duration: Math.max(durationUs, 0),
    tags,
    logs: [],
    processID,
    warnings: null,
  });

  // Subsegments inherit the parent segment's service by default.
  // Swap `serviceName` -> `sub.name` below for one service per subsegment.
  for (const sub of doc.subsegments ?? []) {
    flatten(sub, traceId, serviceName, doc.id, spans, processes);
  }
}

export function convertTrace(trace: XRayTrace): JaegerTraceData {
  const traceID = xrayTraceIdToJaeger(trace.Id);
  const spans: JaegerSpan[] = [];
  const processes: Record<string, JaegerProcess> = {};
  for (const seg of trace.Segments ?? []) {
    const doc = JSON.parse(seg.Document) as XRaySegmentDoc; // Document is a JSON *string*
    const serviceName = doc.name || "unknown";
    flatten(doc, traceID, serviceName, doc.parent_id, spans, processes);
  }
  return { traceID, spans, processes, warnings: null };
}

// ---------- OTLP spans -> Jaeger ----------

// Flatten an OTLP attribute map into Jaeger tags. Scalars map by JS type;
// nested objects/arrays (e.g. aws.xray) are JSON-stringified so nothing is lost.
function attrsToTags(attrs: Record<string, unknown> | undefined): JaegerTag[] {
  const tags: JaegerTag[] = [];
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null) continue;
    if (typeof value === "boolean") tags.push({ key, type: "bool", value });
    else if (typeof value === "number")
      tags.push(
        Number.isInteger(value)
          ? { key, type: "int64", value }
          : { key, type: "string", value: String(value) }
      );
    else if (typeof value === "string") tags.push({ key, type: "string", value });
    else tags.push({ key, type: "string", value: JSON.stringify(value) });
  }
  return tags;
}

// OTLP "SPAN_KIND_SERVER"/"SERVER"/"INTERNAL" -> Jaeger "server"/"internal".
function normalizeKind(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  return kind.replace(/^SPAN_KIND_/i, "").toLowerCase();
}

function otlpSpanServiceName(span: OtlpSpan): string {
  const res = span.resource?.attributes ?? {};
  const attr = span.attributes ?? {};
  return (
    (res["service.name"] as string) ||
    (attr["aws.local.service"] as string) ||
    "unknown"
  );
}

export function convertOtlpSpans(otlpSpans: OtlpSpan[]): JaegerTraceData {
  const traceID = xrayTraceIdToJaeger(otlpSpans[0]?.traceId ?? "");
  const spans: JaegerSpan[] = [];
  const processes: Record<string, JaegerProcess> = {};

  for (const s of otlpSpans) {
    const serviceName = otlpSpanServiceName(s);
    const processID = "p_" + serviceName;
    if (!processes[processID])
      processes[processID] = { serviceName, tags: attrsToTags(s.resource?.attributes) };

    const startTime = s.startTimeUnixNano != null ? nanoToMicros(s.startTimeUnixNano) : 0;
    const duration =
      s.durationNano != null
        ? nanoToMicros(s.durationNano)
        : s.startTimeUnixNano != null && s.endTimeUnixNano != null
          ? nanoToMicros(s.endTimeUnixNano) - startTime
          : 0;

    const tags = attrsToTags(s.attributes);
    const kind = normalizeKind(s.kind);
    if (kind) tags.push({ key: "span.kind", type: "string", value: kind });
    if (s.status?.code === "ERROR") {
      tags.push({ key: "error", type: "bool", value: true });
      if (s.status.message)
        tags.push({ key: "otel.status_description", type: "string", value: s.status.message });
    }

    spans.push({
      traceID,
      spanID: s.spanId,
      operationName: s.name || "unknown",
      references: s.parentSpanId
        ? [{ refType: "CHILD_OF", traceID, spanID: s.parentSpanId }]
        : [],
      startTime,
      duration: Math.max(duration, 0),
      tags,
      logs: [],
      processID,
      warnings: null,
    });
  }

  return { traceID, spans, processes, warnings: null };
}

// ---------- envelope ----------

export function assembleDoc(data: JaegerTraceData[]): JaegerDoc {
  return { data, total: data.length, limit: 0, offset: 0, errors: null };
}

export function toJaegerDoc(traces: XRayTrace[]): JaegerDoc {
  return assembleDoc(traces.map(convertTrace));
}
