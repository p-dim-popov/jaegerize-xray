# jaegerize-xray (`jxr`)

Pull a trace out of **AWS X-Ray** or **CloudWatch Transaction Search** by ID and
print it as **Jaeger UI JSON** on stdout. Trace IDs can be copied straight from
the Jaeger UI (32-char hex) or given in native X-Ray form — both are accepted.

## Install

```bash
npm i -g jaegerize-xray
```

## Use

```bash
# Jaeger-format ID (e.g. from a jaeger.../traces/<id> URL)
jxr 0320dc04049a0152a82d546034008746 > trace.json

# Native X-Ray ID, or several at once
jxr 1-58406520-a006649127e371903a2de979 0320dc04049a0152a82d546034008746 > traces.json
```

Then load the file via **Jaeger UI → Search → "JSON File"**.

JSON goes to **stdout**; progress messages go to **stderr**, so redirects and
pipes stay clean:

```bash
jxr <id> | jq '.data[0].spans | length'
```

### Open it in a browser automatically

`--open` launches a browser, navigates to a Jaeger UI, and drops the converted
trace into the upload dropzone for you — no manual drag-and-drop:

```bash
jxr 0320dc04049a0152a82d546034008746 --open
```

The default UI is the public Jaeger demo
(`https://demo.jaegertracing.io/jaeger`). Jaeger parses the upload **entirely
client-side**, so the hosted demo just renders your local trace — the trace data
is never sent to its backend. Point `--ui` at your own instance to override:

```bash
jxr <id> --open --ui http://localhost:16686
```

`--open` uses [Playwright](https://playwright.dev). After installing the package,
provision the browser once:

```bash
npx playwright install chromium
```

Repeated `--open` runs **reuse one browser**: a single persistent instance runs
in the background and each trace opens in a new tab, rather than spawning a new
browser app every time. It uses a persistent profile, so a login in front of a
private Jaeger is done once. Quit it by closing the browser window (or
`jxr --stop`):

```bash
jxr --stop
```

By default `--open` **detaches** and frees your terminal immediately; the tab
stays open. Pass `--detach false` to stay attached and block until you close the
trace tab or press Ctrl+C:

```bash
jxr <id> --open --detach false
```

### Options

| Flag | Meaning |
|------|---------|
| `--region <r>` | AWS region (default: `$AWS_REGION`, else your `~/.aws/config` profile region) |
| `--legacy-mode [true\|false]` | Also query the deprecated X-Ray `BatchGetTraces` API before CloudWatch (default: `true`). See [CloudWatch Transaction Search](#cloudwatch-transaction-search) |
| `--log-group <name>` | CloudWatch Transaction Search log group (default: `aws/spans`); implies `--legacy-mode false` |
| `--open` | Open the trace in a browser via the Jaeger UI upload dropzone |
| `--ui <url>` | Jaeger UI base URL (default: `https://demo.jaegertracing.io/jaeger`) |
| `--detach [true\|false]` | With `--open`, free the terminal immediately (default: `true`) |
| `--stop` | Close the shared browser |
| `-h`, `--help` | Usage |

Credentials/region resolve through the standard AWS chain (env vars, `~/.aws`,
SSO, instance role) — if `aws xray ...` works for you, so does the legacy path.
The CloudWatch path additionally needs `logs:FilterLogEvents` on the log group
(see [CloudWatch Transaction Search](#cloudwatch-transaction-search) below).

## CloudWatch Transaction Search

Accounts that route tracing through **CloudWatch Transaction Search** send OTLP
spans to the `aws/spans` log group instead of the legacy X-Ray store. Those
traces are visible in the CloudWatch console but `xray:BatchGetTraces` (and so
the X-Ray API) returns nothing for them.

CloudWatch Transaction Search is the primary store. By default `jxr` still
queries the **deprecated** X-Ray `BatchGetTraces` API first (legacy mode), then
fills in any ID it lacked from `aws/spans`, converting the OTLP spans to the
same Jaeger JSON. The CloudWatch path needs `logs:FilterLogEvents` on the log
group. Flags:

```bash
jxr <id> --legacy-mode false    # skip X-Ray, read only CloudWatch (aws/spans)
jxr <id> --log-group my/spans   # custom log group; implies --legacy-mode false
```

Legacy mode is on by default so nothing breaks for accounts still using the
X-Ray store. Turn it off once everything you trace is in CloudWatch.

## How the ID conversion works

X-Ray IDs aren't W3C/Jaeger IDs: `1-58406520-a006...` is `version-epoch-random`.
`jxr` strips/reinserts the dashes to move between the two 32-hex-char and
`1-xxxxxxxx-yyyy...` forms, fetches segments via `BatchGetTraces` (auto-chunked
to the 5-IDs-per-call limit), flattens nested subsegments into linked
`CHILD_OF` spans, converts epoch-seconds to microseconds, and maps HTTP +
fault/error into Jaeger tags.

By default all subsegments inherit their parent segment's service name (keeps
the service graph readable). See the comment in `flatten()` to give each
subsegment its own service node.

OTLP spans from `aws/spans` are already plain hex IDs, so the conversion
(`convertOtlpSpans`) maps `spanId`/`parentSpanId` straight onto Jaeger
references, divides nanosecond timestamps to microseconds, and flattens span +
resource attributes into tags (nested objects are JSON-stringified). Service
name comes from `resource.attributes["service.name"]`, falling back to
`aws.local.service`.

## Develop

```bash
bun install
bun test            # unit tests for the pure conversion logic
bun run dev <id>    # run the CLI from TypeScript source
bun run build       # tsc -> dist/ (also runs on `npm publish` via prepublishOnly)
```

## Roadmap

- Spin up a local Jaeger all-in-one automatically and default `--open` to it,
  so traces that exist only in X-Ray render without any external UI.
