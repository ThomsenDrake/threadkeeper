# Client contract

Customer steps for creating a credential and copying the endpoint are in [README.md](../README.md). This document is the client and operator contract.

MCP clients decide when to invoke capture and recall. Threadkeeper stores and retrieves the personal context they explicitly provide. A connection is not an automatic transcript feed.

## Connection and permissions

1. Sign into the profile and open Connections.
2. Create a separate credential per client. Choose recall (read) access and optionally capture access. A created credential has **Never used** status until a valid bearer request reaches Threadkeeper; an **Active credential** is not proof that an MCP host is installed.
3. Set permitted project IDs. A restricted client can access those projects **plus global context** (`project_id:null`); an unrestricted client can access every project belonging to its owner.
4. Save the displayed token securely. It is shown once, and the database stores its hash.
5. Copy the exact **Remote MCP endpoint** from Connections. It is the operator-configured application origin with `/mcp`, for example `http://localhost:3000/mcp` locally. Send `Authorization: Bearer TOKEN`; the one-time token dialog can copy the token and connection JSON. Tokens remain in that transient dialog and are cleared when it closes or you sign out. Store them securely in the client's own configuration.

Client-specific configuration varies. Two independent official TypeScript SDK instances use Streamable HTTP and modern protocol negotiation. The installed Codex acceptance check below exercises the host's actual MCP transport through explicit tool invocations. A separate published OpenCode check established model-selected capture/recall under explicit prompts through four fresh sessions; its scope is recorded below. Installed ChatGPT/Claude hosts remain untested. Some clients cannot send arbitrary headers and will require a supported authentication flow before integration.

Revocation blocks future requests with the credential. Authorization is checked when a request is admitted; revocation does not cancel an already running request, including an in-flight query-embedding call. It retains previously captured memory and cannot remove copies already delivered to the client's conversation. Owner-only corrections, deletion, full export/import and grant management are performed through the signed-in profile rather than default agent tools.

Model inferences and unaccepted assistant proposals enter **Needs review**. Default recall excludes them until the owner explicitly confirms a candidate, with or without an edit. The confirmed current revision is labeled `user_confirmed` and has separate user-authored confirmation evidence; the original inference/proposal remains in history. Dismissal retains evidence/history with status `dismissed` and removes the record from both the active recall and candidate queue. These owner actions use `POST /api/memories/{id}/review` with `action`, `expected_revision` and optional confirmation `statement`/`effective_at`; they are not client-token MCP tools. Stale revisions return HTTP 409. Generic correction of a candidate requires this explicit review flow.

## Tools

| Tool | Inputs and result |
| --- | --- |
| `context_search` | Natural-language `query`, optional `project_id`, `subject`, `source`, `status`, `limit` (1–100). Defaults to active records. Returns memories, evidence, snapshot version and retrieval coverage. Retrieval is lexical by default, or optional hybrid lexical/vector when configured. `coverage.semantic_search` reports enabled/fallback state; see [retrieval](RETRIEVAL.md). |
| `context_capture` | Stable `idempotency_key`, scope, source `events`, optional `explicit_memories`. Returns durable capture/source IDs, complete/pending state and a job ID when extraction is queued. |
| `context_capture_status` | `capture_id` from a save receipt. Returns current saved, pending, processing, complete, failed or cancelled state, live source/memory IDs and safe job metadata. Available to read or capture credentials; capture-only credentials can inspect only their own captures. |
| `context_get_source` | `source_id`. Returns authorized original evidence, author role, capture method and dates. |

Only tools permitted by a token are advertised. Returned structured JSON is also serialized in a text block for client compatibility. HTTP alternatives are `/api/capture`, `/api/captures/{id}`, `/api/context/search` and `/api/sources/{id}`; their OpenAPI description is `/openapi.json`.

Capturing `events` without `explicit_memories` queues extraction. Supplying explicit records validates and stores them directly. Quote spans must exactly match their referenced event. A `pending` response is not a completed memory write. The implementation limits a capture to 32 events and 64,000 characters, with at most 64 proposed memories.

Keep the original receipt for idempotency, then call `context_capture_status` to observe extraction. Replaying an identical save returns its original receipt; it does not update that receipt's pending state. `saved` means no extraction was requested; `complete` means extraction finished and can contain zero accepted memories. Cancelled captures have no extractable source/job left. Result IDs refer only to remaining canonical records. Job errors contain codes, never arbitrary provider error text.

Owners can open **Captures** in the profile to inspect recent saves, read evidence, open resulting memories and retry eligible failed jobs. The profile API lists `/api/captures?limit=50&offset=0` and retries with `POST /api/captures/{id}/retry` and `{"expected_attempts":1}` using a signed-in owner session. Tokens cannot retry. A retry keeps the same capture, job and source IDs, clears the failed result, and queues another attempt. A stale attempt count or changed state returns HTTP 409. Corrected sources stay blocked, and deleted jobs/sources cannot be retried. The worker must be running with a working configured provider; a queued save alone is not proof that extraction has run. Stale processing jobs can be reclaimed after ten minutes, with current-attempt fencing preventing older responses from overwriting the reclaimed attempt.

Owners can forget a source from its evidence view even before extraction creates a memory. The profile first previews every connected source, memory, history count and removed extraction job. HTTP callers must obtain `GET /api/memories/{id}/deletion-preview` or `GET /api/sources/{id}/deletion-preview`, then send `DELETE /api/memories/{id}` with `{"expected_revision":1,"preview_hash":"<returned hash>"}` or `DELETE /api/sources/{id}` with `{"preview_hash":"<returned hash>"}`. These operations require the signed-in owner session; client tokens cannot preview or delete. A changed impact returns HTTP 409 and requires reviewing and confirming a new preview. Intersecting jobs are removed in full, so their other surviving sources are not automatically extracted.

## Suggested client instructions

> Recall context before making a decision when the user refers to earlier work, or when an unseen durable preference, decision or constraint would materially change the response. Skip redundant recall when the relevant context is already visible or personal history is irrelevant.
>
> Capture only authorized durable information, explicit requests to remember, confirmed decisions and corrections. Send minimal relevant evidence with stable IDs, original author roles and scope. Label a summary as `agent_reported`; never present your suggestion or inference as an original user statement. A missing user objection is not confirmation.
>
> Use retrieved evidence and origin labels. If recall reports insufficient context, say so. Preserve pending/failed write states accurately. Respect project scopes, capture pauses established by the user and revoked access. Send profile edits/deletions to the owner's controls when the client lacks those permissions.

## Pause, resume and observed use

Connections shows whether new captures are allowed. **Pause capture** blocks every new HTTP/MCP capture request, including profile entries and replay of an existing receipt, with HTTP 403 `capture_paused` (MCP returns a tool error). The database checks this state under the same owner lock used for capture admission. A request committed before pause remains saved; requests admitted after pause are rejected. Pause keeps existing data and credentials, and permitted recall/source/status reads stay available. It does not remove previously delivered client context.

Already admitted extraction jobs may complete while paused. The owner can retry eligible failed jobs while paused because their sources were already admitted. Current attempt, correction and deletion fences still apply. Profile correction, review, deletion and import of previously exported data remain available. Resume accepts new capture requests again. Revoke a credential to deny all its subsequent requests; pause and revocation serve different controls.

Owner settings use `GET /api/settings/capture` and `PATCH /api/settings/capture` with `{"paused":true,"expected_version":0}` using a signed-in owner session. The result is `{"paused":true,"version":1}`. The independent settings revision changes only when pause state changes, so unrelated memory activity does not invalidate it. A stale revision returns HTTP 409 `capture_settings_conflict`; refresh before retrying. Client credentials cannot read/change these owner controls. `GET /api/settings/connection` returns the exact configured `mcp_endpoint` to the owner.

**Created** records credential issuance. **Last authenticated request** records only admission of a valid, unrevoked bearer credential, even when the requested operation is subsequently denied. It stores a timestamp, no request content, and does not prove a capture, successful tool call, installed host, or ongoing connection. A revoked credential cannot update that timestamp.

## Remote MCP connection JSON

The one-time token dialog supplies a concrete version of this generic connection object:

```json
{
  "url": "http://localhost:3000/mcp",
  "headers": { "Authorization": "Bearer YOUR_CLIENT_TOKEN" }
}
```

Use Streamable HTTP transport. Hosts use different configuration wrappers; place these endpoint/header values in that host's supported remote MCP configuration. This object is not a claim that a particular ChatGPT/Codex configuration file has been installed. An SDK connection uses `new StreamableHTTPClientTransport(new URL(config.url), {requestInit:{headers:config.headers}})`. Some hosts cannot send arbitrary headers; they need a supported authentication flow before they can connect.

## Installed Codex connection

Codex supports this endpoint with a bearer token obtained from an environment variable. Make the one-time credential available as `THREADKEEPER_TOKEN` through your secure client environment, then substitute the exact endpoint copied from Connections:

```sh
codex mcp add threadkeeper --url http://localhost:3000/mcp --bearer-token-env-var THREADKEEPER_TOKEN
```

Its equivalent Codex configuration is:

```toml
[mcp_servers.threadkeeper]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "THREADKEEPER_TOKEN"
```

The token must be available to the process launching Codex. Keep it out of committed configuration and shell command history. Use a separate scoped credential for each client, and follow the explicit capture/recall instructions below; connecting still does not grant automatic transcript access.

For a credential-free developer acceptance check with an already installed Codex binary, run:

```sh
node --import tsx deploy/installed-codex-check.ts
```

The check creates two isolated temporary Codex homes, separate synthetic credentials, a fresh in-memory PGlite API and ephemeral host threads. It invokes the actual Codex app-server `mcpServer/tool/call` route with explicit arguments and checks scoped capture/recall, original evidence, owner correction/forgetting, pause/resume and revocation. No model turn is submitted; any request to its configured localhost model endpoint fails the check. It removes its hosts, HTTP services, database and temporary credentials afterward. It does not install Codex or alter your existing Codex configuration. `THREADKEEPER_CODEX_BINARY` can select an existing binary, and `--output <path>` saves sanitized evidence.

Only exit status **0** establishes completed acceptance. PASS on stdout remains provisional until the process exits. A handled SIGINT or SIGTERM fails the run and restores earlier `--output` evidence, or removes a newly created artifact; a private rollback journal is retained until natural exit and then removed.

The recorded [installed-host evidence](measurements/codex-host-qa.json) identifies the actual version and run. This is transport and explicit host invocation validation, not a learned model choosing when or what to capture. It does not establish installed ChatGPT/Claude behavior or semantic quality.

## First authorized capture and recall

Create one credential with both recall and capture permissions. Connect using the endpoint and bearer header above. Explicitly ask the client to save this **synthetic** writing preference, then invoke `context_capture` with these arguments (the profile can copy them):

```json
{
  "idempotency_key": "first-context-v1",
  "project_id": null,
  "subject": "self",
  "events": [{
    "id": "first-context-note",
    "text": "Use short paragraphs in my writing.",
    "author_role": "user",
    "origin": "user_explicit",
    "capture_method": "explicit_capture"
  }],
  "explicit_memories": [{
    "statement": "Use short paragraphs in my writing.",
    "kind": "preference",
    "source_event_id": "first-context-note",
    "quote": "Use short paragraphs in my writing.",
    "origin": "user_explicit"
  }]
}
```

`project_id:null` is global personal context, available to all of this owner's credentials that have read permission, including restricted-project credentials. For a project-only note, set an allowed project ID. Reuse the IDs only for retries of this exact save; choose new stable IDs for new content. The explicit example saves a memory immediately without requiring an extraction model. Omitting `explicit_memories` saves a source and returns `pending`; use `context_capture_status` and the profile Captures view to follow its extraction instead of assuming it is ready.

Next invoke `context_search` with:

```json
{"query":"short paragraphs","project_id":null}
```

The result should contain the saved preference with `user_explicit` origin and its source quotation. A separate read credential can make the same recall call. The HTTP equivalents are `POST /api/capture` with the capture JSON and `GET /api/context/search?query=short%20paragraphs`, both with the bearer header; use the MCP example when you specifically need a global-only `project_id:null` search because URL query values are strings. Pause in Connections and try another capture: expect `capture_paused` while recall still works. Resume, then revoke this credential: its next HTTP/MCP request must fail authentication. These are explicit calls, not an automatic transcript feed.

## Synthetic demonstration payload

These two independent events permit deleting the preference without deleting the deadline:

```json
{
  "idempotency_key": "synthetic-launch-v1",
  "project_id": "launch",
  "subject": "self",
  "events": [
    {"id":"launch-deadline-1","text":"The launch deadline is October 20, 2026.","author_role":"user","origin":"user_explicit"},
    {"id":"writing-preference-1","text":"Use short paragraphs in my writing.","author_role":"user","origin":"user_explicit"}
  ],
  "explicit_memories": [
    {"statement":"The launch deadline is October 20, 2026.","kind":"project_state","source_event_id":"launch-deadline-1","quote":"The launch deadline is October 20, 2026.","origin":"user_explicit"},
    {"statement":"Use short paragraphs in my writing.","kind":"preference","source_event_id":"writing-preference-1","quote":"Use short paragraphs in my writing.","origin":"user_explicit"}
  ]
}
```

Client B then calls `context_search` with `{"query":"","project_id":"launch"}`. The profile owner changes the deadline and deletes the preference. Fresh search calls from both clients must see only the corrected deadline. Reusing a capture ID with changed content returns a conflict. Raw source identities and content tombstones prevent known deleted events from being replayed; semantic paraphrase prevention is not established.

### Direct Nebius model turns in the installed Codex host

The installed Codex **0.159.0-alpha.3** explicit MCP invocation check remains valid. Model-selected tool use in this Codex build is still unverified: it accepts only the Responses wire protocol, and its actual serialized request includes fields the measured Nebius Responses schema rejects, even with reasoning effort `none`. Minimal standalone Responses inference succeeded, which does not establish host compatibility. See [protocol evidence](measurements/codex-nebius-protocol-check.json) and [provider verification](PROVIDER_VERIFICATION.md). A compatible bounded protocol for this Codex build must be available before its model-selected lifecycle can be checked; no runtime relay or model substitution is used to bypass this gate. The separate OpenCode result below does not establish Codex compatibility.


### Installed OpenCode model-selected capture and recall

The published Linux x64 **OpenCode 1.18.34** host completed one bounded synthetic lifecycle against the exact direct Nebius Nemotron endpoint/model, with reasoning `none`. Four fresh sessions used two separately scoped Threadkeeper clients. Under explicit prompts and with only the phase's capture or search tool exposed, the model chose one source-only `context_capture` call and six `context_search` calls. The pending capture contained two exact source events and no explicit memories. Threadkeeper's canonical worker ran in process against a disposable PGlite database, extracted both records, and bound their persisted content to the final parsed provider response.

Independent host B retrieved the original deadline and preference. After owner HTTP correction and preview-confirmed forgetting, fresh A and B sessions each retrieved only the authoritative revision-2 deadline. Recall prompts contained no answer values; actual MCP arguments/results were compared with canonical API state. All 12 chat requests (11 host, one application) returned HTTP 200 with complete usage: **19,874 prompt + 1,424 completion = 21,298 tokens**, zero reported reasoning and zero embeddings. All host streams completed and temporary hosts, credentials, API and database state were cleaned up.

This validates prompted model-selected MCP operations and canonical full-text retrieval, not unprompted capture, final-answer wording, general extraction accuracy, semantic embedding recall or other host families. It is separate from the native PostgreSQL/pgvector/container checkpoint. OpenCode remains an optional disposable development dependency and is not added to the normal application install. See the [operator recipe and source attribution](OPENCODE_HOST_VALIDATION.md) and [unchanged raw evidence](measurements/opencode-learned-host.json).
