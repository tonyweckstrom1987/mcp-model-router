# Changelog

All notable changes are recorded in this file. The format follows the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) convention.

## [Unreleased]

### Added
- A runnable routing demo in `examples/routing-demo` with a fake provider: `npm run example` routes tasks through the real router without an API key. An end-to-end test (`test/example.e2e.test.ts`) runs it in CI, and the README has a "Try it in a minute" section (c4eb246, #69).

### Security
- `get_usage` with `includeRaw` no longer returns the full LiteLLM `/user/info` response (which includes `keys[]` metadata such as the key hash, `key_name`, `key_alias`, `user_id`, `team_id` and `metadata`). Only `spend`, `max_budget`, `budget_duration` and `budget_reset_at` are passed through (fd5ff60, #74).
  - **Breaking:** for the LiteLLM provider, `raw` now always has the shape `{ "user_info": { ... } }` with only those four fields, whatever shape LiteLLM returned. Before, `raw` was the unmodified response, so code that read `raw.keys`, `raw.teams`, `raw.user_id` or other fields now finds nothing. Read `summary` instead. The OpenRouter `raw` is not changed.
  - For older LiteLLM versions that return `spend` and `max_budget` at the top level, those values are taken from the top level, and a field missing from `user_info` is filled in from the top level, so `raw` and `summary` are not left empty (fd5ff60, #74).

### Fixed
- Daily budget: an empty `usage` in the model response (`{}`, null fields), zeros, or only one of `prompt_tokens` and `completion_tokens` no longer releases the reservation. Before, for example `usage: {}` settled the reservation to zero, so a backend that does not report usage correctly bypassed the hard-coded daily limit. Usage that cannot be inferred reliably is treated like a missing `usage` field: the reservation stays. The limits themselves are unchanged.

### Changed
- `run_eval` errors for an unreadable, invalid or malformed prompt file now name the file by base name only: no resolved path, no system error text and no values from the file. Schema errors name only the task position and field (for example `1.id: id is duplicated`); before, the duplicate-id error quoted the id from the file (dc99f30, #73).
- **Behavior change:** the usage endpoint's response must be a JSON object. A JSON `null`, number, string or array now makes `get_usage` return an error (`... returned an unexpected response: expected a JSON object`). Before, `null` crashed with "Cannot read properties of null", and a number, string or array gave a "not available" result without an error. A caller that relied on that quiet result now sees an error instead (fd5ff60, #74).
- The HTTP transport now prints a startup warning whenever the host is not a localhost address and `MCP_ALLOWED_HOSTS` is unset (previously only for `0.0.0.0` and `::`). Default behaviour is unchanged (4eea255, #75).
- User-visible error messages and stderr lines (config, eval, routing, model client, HTTP transport, usage and log warnings) are now in English instead of Finnish (3caf3f4, #70).
- The `description` in `package.json` (shown on npmjs.com and in npm search) is now in English. A test keeps it and `keywords` free of Finnish letters (3de7770, #71).
- Tool titles, descriptions, parameter descriptions and the text output of all four tools (`route_and_complete`, `list_models`, `get_usage`, `run_eval`) are in English like the README and `config.example.yaml`. MCP clients and the LLMs behind them read these texts, so an English-speaking user previously got Finnish tool descriptions. `structuredContent` is unchanged (02021f7, #76). The routing demo reads the new `model:` / `(fallback used)` output, and the new test `test/toolText.test.ts` checks that the tool metadata contains no Finnish letters.

### Other
- README: a troubleshooting note explains that `npm ci --ignore-scripts` (or `ignore-scripts=true` in `.npmrc`) skips building the native `better-sqlite3` module, so the server and tests fail with `Could not locate the bindings file`. The fix is `npm rebuild better-sqlite3` (86124eb, #78).
- README: Known limitations now say that a failed or empty model call is not refunded (its reservation stays in the daily budget, as does the reservation of a successful call whose response has no `usage` field) and that the cost limits are constants in `src/lib/limits.ts` that can only be changed by editing the code and rebuilding (57aea7f, #79).
- Tests: the end-to-end test for the routing demo (`test/example.e2e.test.ts`) now detects a stale `dist/` (older than the newest file under `src/`) and then runs from source via `tsx` with a warning, so it no longer tests an old build (d11d196, #80).
- Tests: 66 more Python tests in `test/test_automerge_lisa.py` for the automerge tool `tools/automerge.py` (fbbd478, #50). They cover added-line extraction, the restricted-path and bot-fork reasons, the reviewer's decision, structural reasons, case evaluation, function lookup, `main` and constants. With them `python -m unittest discover` runs 96 tests.
- CI: Python tests (`python -m unittest discover`) run on Python versions 3.10-3.13 (55602a1, #60). `__pycache__/` and `*.pyc` added to `.gitignore`.
- CI: the `mcp-doctor` Action updated from version 0.3.0 to version 0.5.0 (b664ebf, #55).
- README: the `run_eval` model list matches the code: the example configuration shows `eval.allowedModels`, and the text states that each model must be allowed (a `tasks` model or listed in `eval.allowedModels`) (cd99f97, #63).
- Dev dependencies: vite 8.3.6 (32c033d, #56) and 8.3.8 (a77e6b3, #68), vitest 5.1.0 (8aefce2, #57) and undici 7.30.2 (d0284d7, #58).
- README: the output of the "Try it without a key" example matches the current `list_models` behavior (the `(config.yaml)` heading and a warning line when the `/models` lookup fails). Added an example of a successful lookup and stated the CI `mcp-doctor` version. The commands were run in a clean clone without keys.

## [0.1.2] - unreleased

### Added
- The README has been fully translated into English (table of contents anchors updated) (0dcf6be, #51). Fixed two claims that contradicted the code: Bearer authentication runs before JSON parsing (the README claimed the opposite), and the interpretation of the measured comparison now matches the table (`qwen3-coder` was slower and more expensive in the general task type, and faster and cheaper in the other types).
- `list_models` now fetches the models that are actually available from the server's `/models` endpoint (LiteLLM or OpenRouter) instead of reading only `config.yaml`. The result is cached (`provider.modelsCacheTtlMs`, default 60 s), the lookup has a timeout (`provider.modelsTimeoutMs`, default 10 s), and a new optional parameter `refresh` bypasses the cache. If a model from `config.yaml` is missing from the server's list, the row carries a warning. When the lookup fails, the models from `config.yaml` are shown together with a visible error (only the type and HTTP status); the error is not stored in the cache.
- README: English section "Quick start from npm" (installation, copying `config.example.yaml` from the package, and starting with `CONFIG_PATH`) (0f1f917, #49).

### Changed
- `config.example.yaml` is in English like the README: the comments, the example system prompts (`systemPrompt`) and the judge prompt (also in the README's judge example). The npm quick start copies the file as is, so an English-speaking user previously got Finnish prompts for the models. The configuration values are unchanged (checked by parsing the old and the new file). The new test `test/config-example.test.ts` verifies that the example loads and stays in English (#65).
- The error for a missing configuration file is in English, gives the absolute path and the fix, and does not print a stack trace. The exit code is still 1 (0f1f917, #49).

### Fixed
- `provider.timeoutMs` and `tasks.<type>.timeoutMs` accepted any positive integer. With a value above 2,147,483,647 ms, Node's `setTimeout` sets the timer to 1 ms, so every model call timed out immediately and still reserved daily budget. Now loading the configuration rejects the value, and `callChatCompletion` rejects an invalid timeout before the budget reservation and the call. (2145a9a, #61).
- The `${NAME}` substitution in the configuration file inserts the value of the environment variable literally. Previously the value was parsed again, so for example an API key or password containing `${...}` was silently changed, and the value `a${X}` in variable `X` hung the startup in an infinite loop. (2145a9a, #61).
- `run_eval` rejects the same model appearing twice in the list before reading the file and making calls (previously every call was made twice and the summary had two identical rows). A prompt file in which the same `id` repeats is rejected in validation, because the summaries identify cases by `id`. (2145a9a, #61).
- HTTP mode: Bearer authentication runs before JSON parsing. The body of an unauthenticated request is no longer read, so invalid JSON or a too large body gives a 401 instead of Express's HTML error page with a stack trace. A parse error in an authenticated request returns the JSON-RPC error `-32700 Parse error` (review of 28 Oct, finding 9). DNS rebinding protection (the Host header check) works as before. (5dd6e7d, #42).
- HTTP mode: the per-request `McpServer` and transport are now closed also when `connect` or `handleRequest` throws or the connection closes in the middle of handling; previously they were left open (finding 8). (5dd6e7d, #42).
- `run_eval`: extracting the LLM judge's score no longer reads the first number 1-5 from any text. Answers such as "10/10" or "in 2024" no longer give a score of 1 or 2; an unclear answer leaves the score out instead of distorting the average (review of 28 Oct, finding 10). (d2e1d2b, #41).
- `run_eval`: errors from the judge call (including `LimitExceededError`) no longer disappear silently. The per-case `judgeError` and the per-model `judgeErrorCount` tell why a score is missing. (d2e1d2b, #41).
- `run_eval`: the judge call reserves 64 tokens by default instead of 4096 (new optional `eval.judge.maxTokens`, at most the per-call cap of 4096). (d2e1d2b, #41).
- `run_eval` allows only the models of the `tasks` section (`model`, `fallbackModel`) and the optional `eval.allowedModels` list. Previously `models` accepted any identifier, so a token holder could steer calls to the proxy's most expensive model. The check is made before reading files, logging and calls (review of 28 Oct, finding 3; 97ab7ab, #39).
- `get_usage`: the call to the usage endpoint now has a timeout (default 15 s, setting `usage.timeoutMs`). Previously a hanging call waited without limit and kept its own server instance alive in HTTP mode (review of 28 Oct, finding 5; bb139a7, #38; 27eebf9, #40 is a duplicate commit with the same content).
- A logging error (e.g. `SQLITE_READONLY`) no longer triggers the fallback model or crashes `run_eval`. The error is logged to stderr and the result of the model call is preserved (review of 28 Oct, findings 1 and 4; 6d2befa, #37).
- HTTP mode: a `listen` error (e.g. `EADDRINUSE`) is recognized, logged as a code, and the service exits with code 1. Previously Express 5's faulty callback was interpreted as a successful start (b616de3, #52).
- `route_and_complete` accepts only the task types of the configuration file itself; inherited keys (`constructor`, `toString`, `__proto__`) are rejected (b616de3, #52).

### Other
- CI: `mcp-doctor` health check and an offline smoke run; the example configuration's server version fixed to match the package (e2aed26, #36).
- Automerge updated to version 2: it merges only unrestricted PRs approved by the reviewer (32a6eee, #48). Dependabot's automerge applies only to patch and minor updates (ef8dfca, #32).
- Tests: automerge tests (a4347cd, #33), budget tests (62a919b, #43) and an empty `test/__init__.py` so that the repository's own tests win over a test package with the same name (584807d, #53).
- README updates (27e6a8e, #35; b3d0f67, #47).
- Dependencies: express and `@types/express` (e359ea4, #16), `@types/node` 26.6.5 and 26.6.6 (61c3eb4, #10; 1a587ef, #45), vitest 5.0.5 (49b5107, #25), js-yaml 5.5.0 (87d4f26, #27), vite 8.3.5 (ed5edd0, #34), MCP SDK 1.32.2 (27081f7, #46) and evalkit-action (9ac4b39, #24).
- The server's default version (`server.version`) and `config.example.yaml` raised to version 0.1.2.
