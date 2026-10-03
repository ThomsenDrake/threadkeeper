# Client contract

MCP clients decide when to invoke capture and recall. Threadkeeper stores and retrieves the personal context they explicitly provide. A connection is not an automatic transcript feed.

## Connection and permissions

1. Sign into the profile and open Connections.
2. Create a separate credential per client. Choose read access and optionally capture access.
3. Set permitted project IDs. A restricted client can access those projects **plus global context** (`project_id:null`); an unrestricted client can access every project belonging to its owner.
4. Save the displayed token securely. It is shown once, and the database stores its hash.
5. Configure the client's remote MCP endpoint as `http://localhost:3000/mcp` for local operation and send `Authorization: Bearer TOKEN`. Use the deployment's exact configured origin.

Client-specific configuration varies. The tested clients are two independent official TypeScript SDK instances using Streamable HTTP and modern protocol negotiation. No installed chatbot or coding-agent host is claimed as tested yet. Some clients cannot send arbitrary headers and will require a supported authentication flow before integration.

Revocation blocks future requests with the credential. Authorization is checked when a request is admitted; revocation does not cancel an already running request, including an in-flight query-embedding call. It retains previously captured memory and cannot remove copies already delivered to the client's conversation. Owner-only corrections, deletion, full export/import and grant management are performed through the signed-in profile rather than default agent tools.

## Tools

| Tool | Inputs and result |
| --- | --- |
| `context_search` | Natural-language `query`, optional `project_id`, `subject`, `source`, `status`, `limit` (1–100). Defaults to active records. Returns memories, evidence, snapshot version and retrieval coverage. Retrieval is lexical by default, or optional hybrid lexical/vector when configured. `coverage.semantic_search` reports enabled/fallback state; see [retrieval](RETRIEVAL.md). |
| `context_capture` | Stable `idempotency_key`, scope, source `events`, optional `explicit_memories`. Returns durable capture/source IDs, complete/pending state and a job ID when extraction is queued. |
| `context_get_source` | `source_id`. Returns authorized original evidence, author role, capture method and dates. |

Only tools permitted by a token are advertised. Returned structured JSON is also serialized in a text block for client compatibility. HTTP alternatives are `/api/capture`, `/api/context/search` and `/api/sources/{id}`; their OpenAPI description is `/openapi.json`.

Capturing `events` without `explicit_memories` queues extraction. Supplying explicit records validates and stores them directly. Quote spans must exactly match their referenced event. A `pending` response is not a completed memory write. The implementation limits a capture to 32 events and 64,000 characters, with at most 64 proposed memories.

There is no client job-status polling or failed-job retry endpoint in the current slice. Worker logs and database job metadata are the present diagnostic surfaces. Stale processing jobs can be reclaimed after ten minutes, but recovery/retry behavior needs further validation. Fresh search after extraction shows accepted memories, but an empty search alone cannot distinguish missing data from pending/failed extraction. Add that coverage/status contract before presenting it as complete.

## Suggested client instructions

> Recall context before making a decision when the user refers to earlier work, or when an unseen durable preference, decision or constraint would materially change the response. Skip redundant recall when the relevant context is already visible or personal history is irrelevant.
>
> Capture only authorized durable information, explicit requests to remember, confirmed decisions and corrections. Send minimal relevant evidence with stable IDs, original author roles and scope. Label a summary as `agent_reported`; never present your suggestion or inference as an original user statement. A missing user objection is not confirmation.
>
> Use retrieved evidence and origin labels. If recall reports insufficient context, say so. Preserve pending/failed write states accurately. Respect project scopes, capture pauses established by the user and revoked access. Send profile edits/deletions to the owner's controls when the client lacks those permissions.

The current service has no dedicated capture-pause setting. The client must honor a user's pause request by ceasing captures; a server-enforced setting remains development work.

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
