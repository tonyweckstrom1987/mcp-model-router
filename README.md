# mcp-model-router

[![CI](https://github.com/tonyweckstrom1987/mcp-model-router/actions/workflows/ci.yml/badge.svg)](https://github.com/tonyweckstrom1987/mcp-model-router/actions/workflows/ci.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

> **Summary:** An MCP server that *complements* LiteLLM instead of replacing it. It (1) picks a model by task type from `config.yaml`, (2) reads usage and budget from LiteLLM or OpenRouter, and (3) runs the same prompt set across several models and compares cost, latency and quality. Works over stdio or streamable HTTP; SQLite stores only call logs and eval results.

**Technologies:** TypeScript, Node.js 22/24, Model Context Protocol (stdio and streamable HTTP), SQLite, vitest. License: [LICENSE](./LICENSE).

**Contents:** [Quick start from npm](#quick-start-from-npm) · [Quick start from source](#quick-start-from-source) · [Try it without a key](#try-it-without-an-llm-key) · [Architecture](#architecture) · [Installation](#installation) · [MCP tools](#mcp-tools) · [Measured comparison](#example-measured-comparison) · [Claude Desktop / Cursor](#claude-desktop--cursor-configuration) · [Proxmox LXC](#running-in-a-proxmox-lxc) · [Security](#security) · [Known limitations](#known-limitations)

An MCP server that **complements LiteLLM and does not replace it**. LiteLLM and
OpenRouter already handle per-agent keys and spending caps; this server does not
rebuild them. It does three things:

1. **Model selection by task type** - reads the per-task-type models from
   `config.yaml` (e.g. `general`, `code`, `writing`, `orchestration`) and calls
   them through an OpenAI-compatible `/chat/completions` API. The base URL and
   key come from environment variables, and the API can be either a LiteLLM
   proxy or OpenRouter directly. There are no direct Anthropic calls. If the
   primary model fails, the configured fallback model is used.
2. **Usage and budget** - reads them straight from the LiteLLM (`/user/info`) or
   OpenRouter (`/credits`) API. There is no separate usage bookkeeping.
3. **Eval comparison** - runs the same prompt set (a JSON file) across several
   models and reports cost, latency and response side by side, so that a
   cheaper model can be chosen based on measured quality. Quality is judged by
   a simple contains/matches check and an optional LLM judge.

SQLite is used **only** for call logs and eval results - not for usage or
budget bookkeeping.

## Quick start from npm

No clone needed. In an empty directory:

```bash
npm init -y
npm i mcp-model-router
cp node_modules/mcp-model-router/config.example.yaml config.yaml   # edit as needed
CONFIG_PATH=./config.yaml npx mcp-model-router
```

The server speaks MCP over stdio by default, so it waits for a client on stdin. Without a config file it exits with code 1 and a one-line message that names the path it looked for. Set `MCP_TRANSPORT=http` for streamable HTTP (see [Quick start from source](#quick-start-from-source) and [Running](#running)). Calling a model needs `LLM_API_KEY`; `list_models` does not.

Check the server with [mcp-doctor](https://www.npmjs.com/package/@tonyweckstrom/mcp-doctor), no LLM key needed:

```bash
CONFIG_PATH=./config.yaml npx @tonyweckstrom/mcp-doctor --env CONFIG_PATH --strict -- node node_modules/mcp-model-router/dist/index.js
```

## Quick start from source

A first `route_and_complete` call in HTTP mode (assuming LiteLLM is already
running at `http://localhost:4000` and has at least a model configured for the
`general` task):

```bash
npm install && npm run build
cp config.example.yaml config.yaml   # edit as needed
read -s -p "LLM_API_KEY: " LLM_API_KEY; echo
export LLM_API_KEY   # or put it in an environment file; do not type the key on the command line
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"   # required in HTTP mode, at least 32 characters
LLM_BASE_URL=http://localhost:4000 MCP_TRANSPORT=http MCP_HTTP_PORT=3100 npm start &
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"route_and_complete","arguments":{"taskType":"general","prompt":"Sano hei suomeksi"}}}'
```

The last command (`curl`) sends a `tools/call` request to the server's `/mcp`
endpoint and prints the response (as a streamable HTTP event stream). For more
on environment variables, the `stdio` transport and the `GET /healthz` health
check, see [Installation](#installation) and [Running](#running).

## Try it without an LLM key

`list_models` only reads `config.yaml`, so you can try it without LiteLLM or an API key. In stdio mode the server reads JSON-RPC messages from stdin (`sleep 2` keeps the pipe open until the response has arrived):

The command uses `dist/index.js`, so first run `npm install && npm run build` (see [Installation](#installation)).

```bash
cp config.example.yaml config.yaml
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"kokeilu","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_models","arguments":{}}}'; sleep 2) | node dist/index.js
```

The text part of the last line's response with `config.example.yaml` (the server's own messages are in Finnish):

```
Tehtävätyypeittäin määritellyt mallit:
- general: openrouter/deepseek/deepseek-v4.1-flash (varamalli: openrouter/qwen/qwen3-flash)
- code: openrouter/qwen/qwen3-coder (varamalli: openrouter/deepseek/deepseek-v4.1-flash)
- writing: openrouter/anthropic/claude-3.5-sonnet (varamalli: openrouter/openai/gpt-4o-mini)
- orchestration: openrouter/openai/gpt-4o (varamalli: openrouter/anthropic/claude-3.5-sonnet)
```

(In English: "Models defined per task type", with "varamalli" meaning "fallback model".)

## Architecture

```
                       ┌─────────────────────────┐
 AgentScope agent ────▶│   mcp-model-router (MCP) │
 (or other MCP client) │                          │
                       │  route_and_complete       │
                       │  list_models              │
                       │  get_usage                │──▶ LiteLLM proxy / OpenRouter
                       │  run_eval                 │      (OpenAI-compatible API)
                       └───────────┬──────────────┘
                                   │
                                   ▼
                         SQLite (call_log, eval_run, eval_result, token_budget)
```

- **Transports**: stdio (for local use, e.g. Claude Desktop/Cursor) and
  streamable HTTP (so that other containers can reach the server over the
  Tailscale network). HTTP mode is stateless (`sessionIdGenerator: undefined`):
  every request gets its own transport instance, so several agents can call the
  server at the same time. `/mcp` requires a Bearer token (`MCP_AUTH_TOKEN`),
  and network-level restriction (Tailscale ACLs) comes on top of that - see
  [Security](#security).
- **Configuration**: `config.yaml` (with environment variable references, no
  secrets in the file) + the actual values from environment variables.
- **Cost caps are hard-coded** (`src/lib/limits.ts`): `maxTokens` is an
  optional parameter, but its upper limit is 4096 and a daily token budget
  caps total consumption - see [Security](#security).

## Installation

Requires Node.js 22.12 or newer (22 or 24).

```bash
npm install
cp config.example.yaml config.yaml   # edit as needed
npm run build
```

Environment variables (example values, no secrets in the repository):

| Variable            | Description                                                    | Default                   |
|---------------------|----------------------------------------------------------------|----------------------------|
| `LLM_BASE_URL`      | Base URL of the OpenAI-compatible API                          | `http://localhost:4000`   |
| `LLM_API_KEY`       | Key for the API above                                          | (empty)                   |
| `LLM_PROVIDER_KIND` | `litellm` or `openrouter` - see [Model identifiers: LiteLLM vs. direct OpenRouter](#model-identifiers-litellm-vs-direct-openrouter) | `litellm` |
| `USAGE_BASE_URL`    | Base URL of the usage API (usually the same as `LLM_BASE_URL`)  | `http://localhost:4000`   |
| `USAGE_API_KEY`     | Key for the usage API                                          | (empty)                   |
| `CONFIG_PATH`       | Path to the `config.yaml` file                                 | `config.yaml`              |
| `DB_PATH`           | Path to the SQLite file                                        | `./data/mcp-model-router.sqlite` |
| `MCP_TRANSPORT`     | `stdio` or `http`                                              | `stdio`                    |
| `MCP_HTTP_HOST`     | Bind address of the HTTP transport                              | `127.0.0.1`                |
| `MCP_HTTP_PORT`     | Port of the HTTP transport (default changed to 3100 because 3000 is often taken, e.g. by Open WebUI) | `3100`                     |
| `MCP_AUTH_TOKEN`    | **Required in HTTP mode**: Bearer token for the `/mcp` endpoint, at least 32 characters. The server does not start without it | (not set) |
| `EVAL_DIR`          | The only directory `run_eval` reads prompt files from (`.json` only). Without it `run_eval` refuses | (not set) |
| `MCP_ALLOWED_HOSTS` | Comma-separated list of allowed Host headers (DNS rebinding protection) | (not set)      |

### Running

```bash
# stdio (e.g. Claude Desktop / Cursor)
npm start

# streamable HTTP (default: this machine only; for other Tailscale containers set MCP_HTTP_HOST to your own Tailscale address, not 0.0.0.0)
# MCP_AUTH_TOKEN is required (at least 32 characters), e.g. openssl rand -hex 32
MCP_TRANSPORT=http MCP_HTTP_HOST=127.0.0.1 MCP_HTTP_PORT=3100 MCP_AUTH_TOKEN=... npm start
```

In HTTP mode the server answers at `http://<host>:<port>/mcp` and also
provides a `GET /healthz` health check. In stdio mode the corresponding
`tools/call` request is fed to the server from stdin as a single JSON-RPC
message (see [Quick start from source](#quick-start-from-source) for the HTTP
version).

## config.yaml example

See the full example in [`config.example.yaml`](./config.example.yaml).
In short:

```yaml
provider:
  baseUrl: ${LLM_BASE_URL:-http://localhost:4000}
  apiKey: ${LLM_API_KEY:-}
  kind: ${LLM_PROVIDER_KIND:-litellm}   # litellm | openrouter

tasks:
  general:
    model: openrouter/deepseek/deepseek-v4.1-flash
    fallbackModel: openrouter/qwen/qwen3-flash
  code:
    model: openrouter/qwen/qwen3-coder
    fallbackModel: openrouter/deepseek/deepseek-v4.1-flash
  orchestration:
    model: openrouter/openai/gpt-4o
    timeoutMs: 120000   # overrides provider.timeoutMs for this task type

usage:
  provider: litellm   # litellm | openrouter
  baseUrl: ${USAGE_BASE_URL:-http://localhost:4000}
  apiKey: ${USAGE_API_KEY:-}
  # timeoutMs: 15000  # timeout of the usage API (default 15 s)

eval:
  judge:
    enabled: false
    model: openrouter/openai/gpt-4o-mini   # a different model than the models under evaluation, see below
  concurrency: 4   # how many (model, prompt) calls run at the same time
  # run_eval accepts only the models of the tasks section by default; add other models to compare here:
  # allowedModels: [openrouter/anthropic/claude-haiku-5-5]
  pricing:
    openrouter/deepseek/deepseek-v4.1-flash:
      inputPerMillionUsd: 0.2
      outputPerMillionUsd: 0.8

database:
  path: ${DB_PATH:-./data/mcp-model-router.sqlite}
```

### Model identifiers: LiteLLM vs. direct OpenRouter

Model identifiers in the `tasks` block are always written in the form LiteLLM
uses, e.g. `openrouter/deepseek/deepseek-v4.1-flash`. The `openrouter/`
prefix is LiteLLM's own way of saying that the request is routed through
OpenRouter - it is not part of OpenRouter's own model identifier.

- **`provider.kind: litellm`** (default, `LLM_BASE_URL` points to a LiteLLM
  proxy): the identifier is sent as it is, prefix included.
- **`provider.kind: openrouter`** (`LLM_BASE_URL` points directly to
  `https://openrouter.ai/api/v1`): the router strips the `openrouter/` prefix
  automatically before the API call (see `src/lib/modelId.ts`), so the same
  `config.yaml` works unchanged with both - only
  `LLM_BASE_URL`/`LLM_PROVIDER_KIND` change.

### Per-task-type timeout (`timeoutMs`)

`tasks.<taskType>.timeoutMs` is optional and overrides `provider.timeoutMs`
for that task type only (it affects `route_and_complete` calls, for both the
primary model and the fallback model). By default all task types use
`provider.timeoutMs` (default 60000 ms).

This is especially useful for reasoning models, which can take considerably
longer on complex decomposition or orchestration tasks than on simple
general-knowledge or short-code tasks - see
[Example: measured comparison](#example-measured-comparison), where the
"pilkkominen" (decomposition) task type caused timeouts with the 60 s default
timeout:

```yaml
tasks:
  orchestration:
    model: openrouter/deepseek/deepseek-v4.1-flash
    timeoutMs: 120000   # 2 min, instead of the default 60000 ms (1 min)
```

## MCP tools

| Tool                  | Description                                                            |
|-----------------------|-------------------------------------------------------------------------|
| `route_and_complete`  | Picks a model by the `taskType` parameter and completes the prompt. Uses the fallback model when needed. Optional `maxTokens` (integer 1-4096; a larger value is rejected). |
| `list_models`         | Lists the task types in `config.yaml` and the models attached to them. |
| `get_usage`           | Returns the state of usage and budget from LiteLLM/OpenRouter.         |
| `run_eval`            | Runs a JSON prompt set across several models and reports cost/latency/quality. |

For the format of the eval prompt file, see the example
[`examples/eval-prompts.example.json`](./examples/eval-prompts.example.json):

```json
[
  { "id": "p1", "prompt": "Mikä on Suomen pääkaupunki?", "expectedContains": "Helsinki" }
]
```

A larger example set of 15-20 Finnish-language prompts for four task types
(general knowledge, coding, writing/summarising, task decomposition) is in
[`examples/eval-prompts.fi.json`](./examples/eval-prompts.fi.json).

**Checking prompt files (evalkit):** `npm run eval:validate` checks the example files with the
[evalkit](https://github.com/tonyweckstrom1987/evalkit) tool without network calls or costs
(format, duplicate ids, invalid expressions). CI runs it on every push, so a broken
prompt file is caught before `run_eval` meets it. evalkit reads this array format
(`expectedContains`, `category`) as it is.

**Recorded responses (llm-cassette):** `test/cassettes/fi.json` contains the responses of a real model (`deepseek-flash`)
to 20 prompts, and `test/cassettes/fi.baseline.json` holds the results computed from them. `npm run eval:replay`
replays the responses without a network or a key and compares them to the baseline; CI runs it, so a
regression in the evaluation logic (e.g. a change in the checks) fails CI. For a new recording (needs your own LiteLLM key, costs a few cents):
set `EVALKIT_BASE_URL`, `EVALKIT_MODELS` and `LLM_API_KEY`, run `npm run eval:record` and then
`npm run eval:anonymize`, which replaces the real address with a placeholder and refuses if the cassette contains `ts.net`
or a string that looks like a key.

### Running evals (`run_eval`)

`run_eval` is an MCP tool, not a separate CLI command - it is called the same
way as the other tools (`tools/call`, see [Quick start from
source](#quick-start-from-source)). An example in HTTP mode, with two models
and the `eval-prompts.fi.json` set:

Models are restricted: `run_eval` accepts only the models in the `tasks` section of `config.yaml` (`model`,
`fallbackModel`) and the list `eval.allowedModels`. Any other model is rejected before a single call is made, so that
the token holder cannot steer calls to the most expensive model of the proxy.

```bash
# server started with the environment variable EVAL_DIR=/path/mcp-model-router/examples
curl -s -X POST http://127.0.0.1:3100/mcp \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{
      "name":"run_eval",
      "arguments":{
        "promptSetPath":"eval-prompts.fi.json",
        "models":["openrouter/deepseek/deepseek-v4.1-flash","openrouter/qwen/qwen3-flash"],
        "judge": false
      }
    }
  }'
```

- `promptSetPath` is resolved relative to the `EVAL_DIR` directory (see
  [Security](#security)); a path outside the directory is rejected.
- The `models` list uses the same LiteLLM `model_name` aliases as the
  `tasks` block of `config.yaml` (see [Known
  limitations](#known-limitations)). Each model must be allowed: either it
  appears in the `tasks` section (`model` or `fallbackModel`, of any
  `taskType`) or it is listed in `eval.allowedModels`. A model outside both is
  rejected before any call is made. To compare a model that no task uses, add
  it to `eval.allowedModels`. The same model may not appear twice in the list.
- The `judge` parameter (optional) overrides the `eval.judge.enabled` setting
  of `config.yaml` for a single run. When the judge is on, every response is
  additionally sent to `eval.judge.model` to be rated on a scale of 1-5
  (using `eval.judge.systemPrompt` from `config.yaml` or the default) - this
  makes as many extra model calls as there are prompt cases, so it costs more
  and takes longer.
- If a `db` instance is in use (which is always the case when the server is
  started with `dist/index.js` - see `src/index.ts`), every run and result row
  is stored in SQLite (the `eval_run`/`eval_result` tables) in the file that
  `DB_PATH` points to, so runs can also be compared afterwards directly from
  the database.
- An eval can make a lot of model calls: e.g. 2 models × 20 prompts = 40
  (model, prompt) pairs, and each call can take several seconds (or as long as
  `provider.timeoutMs`/the task type's own `timeoutMs` if the model hangs) -
  see [Example: measured comparison](#example-measured-comparison).
  `judge: true` nearly doubles the run time, because every response is also
  rated separately with an extra model call.

**Parallel execution (`eval.concurrency`)**

`run_eval` runs (model, prompt) pairs in parallel, at most as many at a time
as the `eval.concurrency` setting of `config.yaml` allows (default 4, minimum
1). The implementation is a simple bounded work queue
(`mapWithConcurrency`, see `src/eval/runEval.ts`) with no new dependencies:
a fixed number of "workers" take the next unprocessed task from the queue one
at a time until the queue is empty.

The calls are in practice all I/O wait (a network response from the model),
not CPU work, so parallel execution shortens the total run time directly in
proportion to the `concurrency` value - e.g. 2 models × 20 prompts × judge on
(40 response calls + 40 judge calls = 80 calls) used to take about 12 minutes
when run sequentially; with `concurrency: 4` the same calls go four at a time,
which shortens the run time considerably with the same prompt set and model
selection.

Notes:

- **Result order is preserved** regardless of the order in which individual
  calls finish: the `cases` array is always in the same order as in a
  sequential run (model as the outer loop, prompt as the inner loop, in the
  order of `input.models`/the prompt file).
- **Error handling is still per call**: a timeout or other error in one call
  (including a judge call error) does not interrupt the other parallel or
  queued calls - it shows only in the `error` field of that case, just as in a
  sequential run.
- **Why the default is 4, not more**: too much parallelism can overload the
  rate limits of the LiteLLM proxy or OpenRouter, so that some calls start to
  fail with 429 errors instead of the eval actually getting faster. Raise the
  value carefully according to the limits of your own proxy/API key, or lower
  it to `1` if you want a fully sequential run (the simplest in terms of
  deterministic timing), e.g. for troubleshooting.

**Reading the results** (`EvalReport`, see `src/eval/runEval.ts`):

- `cases`: one row per (model, prompt) - contains `latencyMs`, the `response`
  text, `passed` (`true`/`false`/`null` if the prompt has no
  `expectedContains` field), `judgeScore` (1-5 or `null`), `priceUsd` (`null`
  if the model has no price entry in the `eval.pricing` block of
  `config.yaml`) and `error` (an error message or `null`).
- `perModel`: a summary per model - `avgLatencyMs`, `passRate` (the share of
  `expectedContains` passes, 0-1, **with failed calls excluded**, `null` if
  none of the prompts had an `expectedContains` field), `avgJudgeScore`,
  `avgPriceUsd` and `errorCount`/`caseCount`. This is the fastest way to
  compare models: a lower `avgPriceUsd` and `avgLatencyMs` while
  `passRate`/`avgJudgeScore` stays high enough tells you which model to pick
  for the `tasks` block of `config.yaml`.
- `perTaskType`: the same summary grouped by (model, task type) pairs. The
  task type is derived from the prefix of the prompt `id` by dropping the
  trailing `-<number>`, e.g. `"yleinen-01"` → `"yleinen"`,
  `"pilkkominen-05"` → `"pilkkominen"` (see `taskTypeFromPromptId` in
  `src/eval/runEval.ts`) - this has nothing to do with the `tasks` keys of
  `config.yaml`, it is just a naming convention in the prompt file. Each row
  contains:
  - `caseCount`, `errorCount` - how many cases and how many of them were
    errors.
  - `passedCount`/`expectedCount` - how many passed the keyword check among
    the cases where `expectedContains` was given (= "passed/n").
  - `passRateExcludingErrors` - the pass rate computed only over successful
    calls (failed calls are left out of both the numerator and the
    denominator). It tells the quality of the response when the model did
    respond at all.
  - `passRateIncludingErrors` - the pass rate computed so that errors (e.g.
    a timeout) count as not passed (included in the denominator). It tells the
    overall reliability of the model for the task type.
  - `avgLatencyMs`, `avgPriceUsd` - as in `perModel`, but limited to this task
    type.
- The text response of the MCP tool summarises both the `perModel` and the
  `perTaskType` rows in a human-readable form; the whole `EvalReport`
  (including `cases`) is available programmatically in the
  `structuredContent` field.

**Judge mode (`eval.judge`) - a more reliable quality metric**

The `expectedContains` keyword check is coarse: it rejects even a good
response if it does not contain exactly the expected word (see [Example:
measured comparison](#example-measured-comparison) - especially on
writing/summarising tasks it gives a misleadingly low pass rate). The LLM
judge rates the quality of the response on a scale of 1-5 regardless of
whether the response hits the expected wording exactly, and is therefore a
more reliable metric especially for open-ended (writing, summarising,
decomposition) tasks.

Enable the judge either permanently in `config.yaml` or for a single run:

```yaml
eval:
  judge:
    enabled: true
    model: openrouter/openai/gpt-4o-mini   # the model acting as judge
    systemPrompt: "Olet tiukka arvioija. Anna vastauksen laadulle asteikolla 1-5 pelkkä numero."
```

or pass `"judge": true` in the `arguments` field of the `run_eval` call (see
the example above) - this overrides the `config.yaml` setting for that run
only. As a result `EvalCaseResult.judgeScore`/`EvalModelSummary.avgJudgeScore`
are filled in instead of `null`. Note the effect on cost: the judge makes one
extra model call per prompt case, so it both costs and takes roughly twice as
much as the keyword check.

The `max_tokens` of a judge call is 64 by default, because the response is a
single number. If the judge model uses reasoning tokens, raise the value with
the optional `eval.judge.maxTokens` setting (1-4096). If no judge score is
obtained (the call fails or the response has no unambiguous score from 1 to
5), the score is left as `null`, and the reason shows in the `judgeError` field
of the case and in the per-model `judgeErrorCount` figure.

**Choose `eval.judge.model` to be a different model than the models under
evaluation.** A model typically favours its own response style (e.g. its own
way of structuring a response or phrasing sentences), so the same model as a
judge would give higher scores to responses resembling its own style - this
skews the comparison in favour of that very model. So use as the judge a model
that is not on the `models` list of any `run_eval` call.

## Example: measured comparison

Below are the results of one real `run_eval` run (`examples/eval-prompts.fi.json`,
20 prompts, judge off) that compared two models run through OpenRouter behind
a LiteLLM proxy: `deepseek-v4.1-flash` vs. `qwen3-coder`. Numbers use English
formatting (a comma as the thousands separator and a point as the decimal
separator).

**Overall:**

| Model               | Pass rate     | Avg. latency | Avg. price/call |
|---------------------|---------------|--------------|------------------|
| deepseek-v4.1-flash | 83 % (15/18, 2 timeouts) | 14,802 ms | 0.000744 USD |
| qwen3-coder         | 85 % (17/20)  | 9,887 ms     | 0.000466 USD |

**By task type** (passed/n, avg. latency, avg. price in USD/call):

| Task type | deepseek-v4.1-flash | qwen3-coder |
|---|---|---|
| yleinen (general) | 5/5, 2,190 ms, 0.000119 | 5/5, 5,600 ms, 0.000159 |
| koodaus (coding) | 5/5, 4,025 ms, 0.000278 | 5/5, 3,742 ms, 0.000188 |
| kirjoitus (writing) | 3/5, 7,841 ms, 0.000416 | 3/5, 1,567 ms, 0.000121 |
| pilkkominen (decomposition) | 2/5 (+2 timeouts), 45,151 ms, 0.001867 | 4/5, 28,640 ms, 0.001395 |

**Interpretation:** the overall pass rate is close for both models, but
`qwen3-coder` is both faster and cheaper in the coding, writing and
decomposition task types of this run. In the general task type it was both
slower (5,600 ms vs. 2,190 ms) and more expensive (0.000159 vs. 0.000119
USD). It also got through the decomposition tasks without timeouts. The two timeouts of
`deepseek-v4.1-flash` both hit decomposition tasks (with the 60 s default
timeout) - see
[Per-task-type timeout](#per-task-type-timeout-timeoutms), which exists for
exactly this.

**Limitations - read these numbers with care:**

- **Small sample**: only 5 prompts per task type (20 in total). A single case
  changes the percentage by 20 percentage points; the results should not be
  generalised directly to other prompts or use cases.
- **The keyword check rates writing tasks poorly**: `expectedContains`
  rejects an otherwise good response if it does not contain exactly the
  expected word - the 3/5 figures in the writing/summarising row for both
  models probably underestimate the real quality. See [Judge mode](#running-evals-run_eval)
  for a more reliable alternative.
- **Deepseek's timeouts** raised its average latency and price in the
  decomposition column significantly (60 s per timeout is counted in the
  latency) - without them the average latency would have been lower.
- **The results are from a single run** (run `be440639-9aa7-4330-8c66-8cb2ed27b9ef`)
  at a particular time and depend on the model versions of that moment and on
  OpenRouter's load/availability - they are not a lasting benchmark result,
  but an example of how to read the result report of `run_eval`. Run your own
  eval with your own prompts before production decisions.

## Claude Desktop / Cursor configuration

`claude_desktop_config.json` (or the corresponding Cursor MCP settings file),
with the stdio transport:

```json
{
  "mcpServers": {
    "model-router": {
      "command": "node",
      "args": ["/polku/mcp-model-router/dist/index.js"],
      "env": {
        "CONFIG_PATH": "/polku/mcp-model-router/config.yaml",
        "LLM_BASE_URL": "http://localhost:4000",
        "LLM_API_KEY": "sk-...",
        "DB_PATH": "/polku/mcp-model-router/data/mcp-model-router.sqlite"
      }
    }
  }
}
```

If the server is already running in HTTP mode (e.g. in its own LXC container),
many MCP clients also support a direct streamable HTTP connection to
`http://<tailscale-host>:3100/mcp` without a `command` launch - see the
documentation of your client.

## Running in a Proxmox LXC

No Docker - the server runs directly as a Node process under a systemd unit.

1. Create (or use) a Debian/Ubuntu-based LXC container and install Node.js 22 or 24.
2. Clone the repository into `/opt/mcp-model-router` and run:
   ```bash
   cd /opt/mcp-model-router
   npm ci
   npm run build
   cp config.example.yaml config.yaml   # edit
   ```
3. Create a dedicated user and data directory for the service:
   ```bash
   useradd --system --home /opt/mcp-model-router --shell /usr/sbin/nologin mcp-model-router
   mkdir -p /opt/mcp-model-router/data
   chown -R mcp-model-router:mcp-model-router /opt/mcp-model-router
   ```
4. Copy the environment file and fill in the values (not into version control):
   ```bash
   cp systemd/mcp-model-router.env.example /opt/mcp-model-router/mcp-model-router.env
   chmod 600 /opt/mcp-model-router/mcp-model-router.env
   ```
5. Install the systemd unit; see the ready-made example
   [`systemd/mcp-model-router.service`](./systemd/mcp-model-router.service):
   ```bash
   cp systemd/mcp-model-router.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now mcp-model-router
   systemctl status mcp-model-router
   ```

The unit listens on the `MCP_HTTP_HOST` address (set the container's
Tailscale address, `tailscale ip -4`, in the env file), so that other LXC
containers can reach the server over the Tailscale network. The env file must
contain `MCP_AUTH_TOKEN` (at least 32 characters), otherwise the server does
not start, and clients must send it in the Bearer header. Also set
`EVAL_DIR` if you use `run_eval`. Access is additionally restricted with
Tailscale ACLs.

## Security

Principle: the limits are in the code and they fail closed (in an error
state, the action is denied). None of the limits below can be loosened with an
environment variable, with `config.yaml` or with a tool parameter.

**Bearer authentication (`MCP_AUTH_TOKEN`).** In HTTP mode `/mcp` (POST, GET,
DELETE) requires the header `Authorization: Bearer <token>`.

- The server **does not start** in HTTP mode if `MCP_AUTH_TOKEN` is missing or
  shorter than 32 characters. Create a token with e.g. `openssl rand -hex 32`.
- A missing header, a wrong scheme and a wrong token all give exactly the same
  401 response, which does not reveal the reason. The comparison is
  constant-time (`crypto.timingSafeEqual` on SHA-256 digests, so inputs of
  different lengths do not leak information).
- The token is not written to logs or error messages. Keep it in an
  environment file (`chmod 600`), not in version control.
- The default bind is `127.0.0.1`. `/healthz` is open and returns nothing but
  `{"status":"ok"}`.
- The stdio mode does not use a token (the process is local).
- The token does not replace network-level restriction: keep using Tailscale
  ACLs and do not listen on `0.0.0.0`.
- **The Bearer token travels unencrypted over HTTP.** Use HTTP mode only over
  Tailscale (WireGuard) or localhost, never over an open network.
- Authentication runs before the JSON body is parsed, so the body of an
  unauthenticated request is not read. A parse error in an authenticated
  request returns the JSON-RPC error `-32700 Parse error`. The DNS rebinding
  protection (Host header check) is applied before that.

**`run_eval` file paths (`EVAL_DIR`).** `run_eval` reads prompt files from a
single directory only.

- If `EVAL_DIR` is not set, `run_eval` refuses all paths.
- The path is resolved with `realpath` and compared to the directory: `../`
  paths, absolute paths outside the directory and symlinks that lead out are
  rejected. Relative paths are interpreted relative to `EVAL_DIR`.
- Only `.json` extensions (case-insensitive), checked after `realpath`.
- The rejection message is always the same and does not contain the path.

**Cost caps** (constants in [`src/lib/limits.ts`](./src/lib/limits.ts),
checked in `callChatCompletion`, so they cover `route_and_complete`,
`run_eval` and the judge):

| Limit | Value | Behaviour |
|-------|-------|-----------|
| `max_tokens` per call | 4096 | A larger requested `maxTokens` is **rejected with an error** (not silently reduced). If no value is given, 4096 is sent to the API. |
| Model calls per `run_eval` | 200 | Counted as models × prompts (× 2 if the judge is on). Exceeding it is rejected before the first call. |
| Daily budget | 1,000,000 tokens / day | A day is defined in `Europe/Helsinki` time. |

The daily budget works on a reservation principle: before every call, the
input estimate + `max_tokens` is reserved from the SQLite `token_budget` table
in a `BEGIN IMMEDIATE` transaction (the check and the reservation are
indivisible, so parallel calls cannot bypass the limit). After the call the
reservation is corrected to the `usage` value of the response. If `usage` is
missing, the reservation stays in effect. A failed and an empty response
consume budget. Exceeding the budget does not trigger the fallback model.
Changing the limit requires a code change.

**Empty responses.** An empty, whitespace-only or missing response is the
error `vastaus_tyhja`, not a success. In `run_eval` it is a failed case
(`passed: false`, `error` starts with `vastaus_tyhja`) and is counted in the
denominator of the pass rate.

## Development

```bash
npm run dev          # tsx, stdio transport straight from the source
npm run typecheck    # tsc --noEmit
npm test             # vitest, HTTP calls mocked with undici
```

CI also runs [mcp-doctor](https://github.com/tonyweckstrom1987/mcp-doctor) (MCP handshake, tool schemas and an offline smoke run `test/mcp-doctor/smoke.json`). Locally:

```bash
npm run build
CONFIG_PATH=$PWD/config.example.yaml npx @tonyweckstrom/mcp-doctor --env CONFIG_PATH --strict --smoke test/mcp-doctor/smoke.json -- node dist/index.js
```

## Known limitations

- HTTP mode authentication is a single shared Bearer token (no per-user or
  per-agent credentials, no token rotation at run time), and the server does
  not encrypt traffic itself (HTTP does not encrypt the token), so traffic may
  travel only through `127.0.0.1` or Tailscale.
- The daily budget is token-based and covers only calls made through this
  server; it does not know about consumption by other LiteLLM/OpenRouter
  clients (`get_usage` shows it).
- The input token count is an estimate (character count / 3); the reservation
  is corrected to the actual `usage` value only after the call.
- There is no automatic model list fetch from LiteLLM's `/models` API -
  `list_models` reads only `config.yaml`.
- The eval price estimate is based on the `eval.pricing` price list in
  `config.yaml`, not on automatic price lookup from OpenRouter.
- `get_usage` requires that LiteLLM has been started with a database
  (Postgres) and that `USAGE_API_KEY` is LiteLLM's **master key**
  (`LITELLM_MASTER_KEY`), because `/user/info` is an admin API. Without a
  database LiteLLM returns `"Database not connected"` (HTTP 500), and
  `get_usage` passes this error on to the caller as it is. OpenRouter-only
  use (`usage.provider: openrouter`) does not require a database.
- The model identifiers of the `tasks` block and of `run_eval` are LiteLLM
  `model_name` aliases (names defined in the LiteLLM configuration/proxy model
  list), not directly the model identifiers of OpenRouter or another backend.
  See [Model identifiers: LiteLLM vs. direct
  OpenRouter](#model-identifiers-litellm-vs-direct-openrouter).
