# cheap-aws-jaeger (`caj`)

Pull a trace out of **AWS X-Ray** by ID and print it as **Jaeger UI JSON** on stdout.
Trace IDs can be copied straight from the Jaeger UI (32-char hex) or given in
native X-Ray form — both are accepted.

## Install

```bash
npm i -g cheap-aws-jaeger
```

## Use

```bash
# Jaeger-format ID (e.g. from a jaeger.../traces/<id> URL)
caj 0320dc04049a0152a82d546034008746 > trace.json

# Native X-Ray ID, or several at once
caj 1-58406520-a006649127e371903a2de979 0320dc04049a0152a82d546034008746 > traces.json
```

Then load the file via **Jaeger UI → Search → "JSON File"**.

JSON goes to **stdout**; progress messages go to **stderr**, so redirects and
pipes stay clean:

```bash
caj <id> | jq '.data[0].spans | length'
```

### Options

| Flag | Meaning |
|------|---------|
| `--region <r>` | AWS region (default: `$AWS_REGION` or `us-east-1`) |
| `-h`, `--help` | Usage |

Credentials/region resolve through the standard AWS chain (env vars, `~/.aws`,
SSO, instance role) — if `aws xray ...` works for you, so does `caj`.

## How the ID conversion works

X-Ray IDs aren't W3C/Jaeger IDs: `1-58406520-a006...` is `version-epoch-random`.
`caj` strips/reinserts the dashes to move between the two 32-hex-char and
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

- `--open` to auto-launch a local Jaeger UI and open the trace in the browser.
