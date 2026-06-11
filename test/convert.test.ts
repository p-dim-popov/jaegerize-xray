import { test, expect } from "bun:test";
import {
  xrayTraceIdToJaeger,
  jaegerTraceIdToXray,
  normalizeToXray,
  toMicros,
  nanoToMicros,
  convertTrace,
  convertOtlpSpans,
  toJaegerDoc,
  type XRayTrace,
  type OtlpSpan,
} from "../src/convert.js";

test("xray -> jaeger id strips the leading 1- and dashes", () => {
  expect(xrayTraceIdToJaeger("1-58406520-a006649127e371903a2de979")).toBe(
    "58406520a006649127e371903a2de979"
  );
});

test("jaeger -> xray id reinserts the version and timestamp dashes", () => {
  expect(jaegerTraceIdToXray("0320dc04049a0152a82d546034008746")).toBe(
    "1-0320dc04-049a0152a82d546034008746"
  );
});

test("round-trip jaeger -> xray -> jaeger is stable", () => {
  const j = "0320dc04049a0152a82d546034008746";
  expect(xrayTraceIdToJaeger(jaegerTraceIdToXray(j))).toBe(j);
});

test("normalizeToXray accepts jaeger hex", () => {
  expect(normalizeToXray("0320dc04049a0152a82d546034008746")).toBe(
    "1-0320dc04-049a0152a82d546034008746"
  );
});

test("normalizeToXray passes through native xray ids", () => {
  expect(normalizeToXray("1-58406520-a006649127e371903a2de979")).toBe(
    "1-58406520-a006649127e371903a2de979"
  );
});

test("normalizeToXray rejects garbage", () => {
  expect(() => normalizeToXray("not-a-trace")).toThrow();
});

test("toMicros converts fractional epoch seconds to integer microseconds", () => {
  expect(toMicros(1.5)).toBe(1_500_000);
});

test("convertTrace flattens subsegments into linked spans", () => {
  const trace: XRayTrace = {
    Id: "1-58406520-a006649127e371903a2de979",
    Segments: [
      {
        Document: JSON.stringify({
          id: "parent01",
          name: "my-api",
          start_time: 1,
          end_time: 2,
          http: { request: { method: "GET", url: "http://x" }, response: { status: 200 } },
          subsegments: [{ id: "child001", name: "ddb", start_time: 1.1, end_time: 1.2 }],
        }),
      },
    ],
  };
  const { traceID, spans, processes } = convertTrace(trace);
  expect(traceID).toBe("58406520a006649127e371903a2de979");
  expect(spans).toHaveLength(2);
  const child = spans.find((s) => s.spanID === "child001")!;
  expect(child.references).toEqual([{ refType: "CHILD_OF", traceID, spanID: "parent01" }]);
  expect(child.processID).toBe("p_my-api"); // inherits parent service
  expect(processes["p_my-api"]!.serviceName).toBe("my-api");
});

test("fault maps to error=true tag", () => {
  const trace: XRayTrace = {
    Id: "1-58406520-a006649127e371903a2de979",
    Segments: [
      {
        Document: JSON.stringify({
          id: "s1",
          name: "svc",
          start_time: 1,
          end_time: 2,
          fault: true,
        }),
      },
    ],
  };
  const span = convertTrace(trace).spans[0]!;
  expect(span.tags).toContainEqual({ key: "error", type: "bool", value: true });
});

test("toJaegerDoc wraps traces in the Jaeger envelope", () => {
  expect(toJaegerDoc([])).toEqual({ data: [], total: 0, limit: 0, offset: 0, errors: null });
});

test("nanoToMicros divides nanoseconds down to integer microseconds", () => {
  expect(nanoToMicros(1_700_000_000_703_000)).toBe(1_700_000_000_703);
  expect(nanoToMicros(40_704)).toBe(41);
});

const otlpSpan = (over: Partial<OtlpSpan> = {}): OtlpSpan => ({
  traceId: "0320dc04049a0152a82d546034008746",
  spanId: "aaaa0000bbbb0001",
  name: "GET /things",
  kind: "SERVER",
  startTimeUnixNano: 1_700_000_000_703_000,
  durationNano: 40_704_000,
  attributes: { "http.method": "GET", "http.status_code": 200 },
  status: { code: "UNSET" },
  resource: { attributes: { "service.name": "my-api" } },
  ...over,
});

test("convertOtlpSpans maps OTLP spans onto a Jaeger trace", () => {
  const { traceID, spans, processes } = convertOtlpSpans([
    otlpSpan(),
    otlpSpan({ spanId: "child0001", parentSpanId: "aaaa0000bbbb0001", name: "db.query", kind: "CLIENT" }),
  ]);
  expect(traceID).toBe("0320dc04049a0152a82d546034008746");
  expect(spans).toHaveLength(2);
  const root = spans.find((s) => s.spanID === "aaaa0000bbbb0001")!;
  expect(root.operationName).toBe("GET /things");
  expect(root.startTime).toBe(1_700_000_000_703);
  expect(root.duration).toBe(40_704);
  expect(root.references).toEqual([]);
  expect(root.tags).toContainEqual({ key: "span.kind", type: "string", value: "server" });
  expect(root.tags).toContainEqual({ key: "http.status_code", type: "int64", value: 200 });
  expect(root.processID).toBe("p_my-api");
  expect(processes["p_my-api"]!.serviceName).toBe("my-api");
  const child = spans.find((s) => s.spanID === "child0001")!;
  expect(child.references).toEqual([
    { refType: "CHILD_OF", traceID, spanID: "aaaa0000bbbb0001" },
  ]);
});

test("convertOtlpSpans maps status ERROR to an error tag", () => {
  const span = convertOtlpSpans([
    otlpSpan({ status: { code: "ERROR", message: "boom" } }),
  ]).spans[0]!;
  expect(span.tags).toContainEqual({ key: "error", type: "bool", value: true });
  expect(span.tags).toContainEqual({ key: "otel.status_description", type: "string", value: "boom" });
});

test("convertOtlpSpans stringifies nested attribute objects", () => {
  const span = convertOtlpSpans([
    otlpSpan({ attributes: { "aws.xray": { sdk: "otel" } } }),
  ]).spans[0]!;
  expect(span.tags).toContainEqual({ key: "aws.xray", type: "string", value: '{"sdk":"otel"}' });
});

test("convertOtlpSpans falls back to aws.local.service then unknown", () => {
  const noService = convertOtlpSpans([
    otlpSpan({ resource: { attributes: {} }, attributes: { "aws.local.service": "fallback-svc" } }),
  ]);
  expect(noService.processes["p_fallback-svc"]!.serviceName).toBe("fallback-svc");
});
