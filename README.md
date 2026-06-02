# jaegerize-xray (`jxr`)

Pull a trace out of **AWS X-Ray** by ID and print it as **Jaeger UI JSON** on stdout.
Trace IDs can be copied straight from the Jaeger UI (32-char hex) or given in
native X-Ray form — both are accepted.

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

Each `--open` launches a fresh, isolated browser instance, so you can have
several trace windows open at once. (A private Jaeger behind a login will
therefore prompt each run — a `--user-data-dir` option to persist that is on the
roadmap.)

By default `--open` **detaches**: the browser is handed to a background process
and your terminal is freed immediately. The window stays open until you close
it. To instead stay attached (block until you close the window or press
Ctrl+C), pass `--detach false`:

```bash
jxr <id> --open --detach false
```

### Options

| Flag | Meaning |
|------|---------|
| `--region <r>` | AWS region (default: `$AWS_REGION` or `us-east-1`) |
| `--open` | Open the trace in a browser via the Jaeger UI upload dropzone |
| `--ui <url>` | Jaeger UI base URL (default: `https://demo.jaegertracing.io/jaeger`) |
| `--detach [true\|false]` | With `--open`, detach the browser and free the terminal (default: `true`) |
| `-h`, `--help` | Usage |

Credentials/region resolve through the standard AWS chain (env vars, `~/.aws`,
SSO, instance role) — if `aws xray ...` works for you, so does `jxr`.

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
