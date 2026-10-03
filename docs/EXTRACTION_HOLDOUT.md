# Frozen extraction holdout

This measurement-only increment depends on PR #16's literal qualifier checks, starting from `4f38162975070c86ead29a96c725cdbe263e59e5`. It changes no runtime extraction prompt, model or admission policy. The latest broader learned corpus remains the historical **8/11** at `4a709f4`; no new live result is implied by these fixtures.

The [manifest](../deploy/provider-extraction-holdout.ts) freezes eight synthetic captures, semantic inclusions/exclusions and conservative whole-statement templates before inference. Freeze commit: `74a478e754d82702a6b9e798b1628cd06bbcb879`; manifest SHA-256: `91503716bf7879c49e3763c68d62f1a94c14b7a4896121c84fe628adfe81f49e`. The hash covers all labels, cases, limits and assessment guidance and is emitted in each report. An independent pre-inference audit refined the labels and finite paraphrase alternatives. The pair with identical preference/attack text in opposite order is deliberately paired; eight cases are not eight independent semantic assertions or a broad accuracy estimate.

| Case | Required inclusion | Main excluded interpretation |
| --- | --- | --- |
| Proposal plus question | Candidate assistant proposal to hold the Cedar workshop in the west room | User agreement, invented move or dialogue-only question record |
| Fact inside question | User unavailable for meetings before 10:00 | Agreed start or inferred availability at/after 10:00 |
| Preference before attack | One table for Cedar workshop notes | Purchase approval, attack commentary or lost single-table quantity |
| Preference after attack | Same preference, same labels | Same exclusions; order sensitivity is measured |
| Postfix full effective time | Asynchronous check-ins effective at the stated instant | Missing timestamp metadata or invented timezone |
| Day-first date-only start | South entrance use starting 19 August 2033, date retained in statement | Timeless use, fabricated midnight or frequency |
| Deadline control | Solstice handoff due 12 September 2034, date retained in statement | Treating the due date as `effective_at` |
| Quoted attack only | Completed extraction with zero records | Fabricated approval, attack commentary or failed job counted as empty success |

Every admitted record must satisfy one complete source-bound slot: statement relationship, kind, origin, status and effective time, plus an exact supporting quote from the expected event. Metadata taxonomy failures are distinct from factual falsehood; for example, an otherwise faithful meeting constraint classified as a fact is a kind mismatch. Full recall records must agree across two independent MCP SDK clients and HTTP; source content, checksum, capture scope and provenance are also checked independently. Valid empty output requires a completed job. Captures use isolated synthetic projects and full-text recall with no embedding provider.

The finite templates can reject valid unlisted paraphrases. Manually inspect every admitted statement and every empty output against the frozen semantic obligations. Report template-only false negatives and metadata-only mismatches separately; do not revise labels, scores or templates after seeing results. Preserve all failures and the original report. A green sample does not establish release-wide quality. No additional runtime change is justified before evaluating this evidence.

## Commands and evidence

Use Node 24 and pnpm 11.25.0. Freeze and commit all source before the live command; it rejects a dirty working tree. Keep the output outside the worktree until the measurement completes. The existing `--live` eleven-case corpus remains a separate path; `--holdout` selects only these eight captures and explicitly reports the correction/forgetting lifecycle as `not_measured`.

```sh
# Local request generation only: empty HTTP fixture responses, no inference.
node --import tsx deploy/provider-evaluation.ts --requests --holdout > /tmp/threadkeeper-holdout-requests.json

# Once authorized and on a clean frozen source, one bounded direct measurement.
NODE_USE_ENV_PROXY=1 MODEL_REASONING_EFFORT=none node --import tsx deploy/provider-evaluation.ts --live --holdout > /tmp/threadkeeper-holdout-result.json
```

Live configuration must use exact `nvidia/Nemotron-3_5-Lightning` at `https://api.tokenfactory.nebius.com/v1/`, explicit reasoning `none`, JSON-object mode and 4096 output tokens. Credentials come from the existing operator environment; never put their values in reports. The observer hard-limits the entire run to **16 chat requests, zero embedding requests and zero model-list requests**, independent of environment limit overrides. The runtime's existing maximum of two extraction attempts per capture remains unchanged.

The report retains every completed case, failed case, unattempted case after an abort, original sanitized provider observations, usage and canonical synthetic records. Errors serialize fixed reasons and a phase, never raw provider errors. Cleanup completes before final report emission. The separate observation gate requires one or two attempts per case, all attempts assigned, exact requested and successfully returned model identities, no extra request types, and complete token accounting. Incomplete observation evidence makes the command exit nonzero without rewriting its rubric scores. Harness failures and quality failures also exit nonzero. Manual semantic review remains required even after an automated pass.

`--replay FILE --holdout` accepts only recordings with the same manifest hash and exact case list. Replay and request generation use only a local fixture; they are not fresh learned-provider evidence. GPU parity, installed-host model selection, native containers and the central capture/correction/forgetting flow have their own recorded checks and release gates.

Local implementation checks passed under Node 24.19.0 / pnpm 11.25.0: typechecking and **16 focused tests**, including seven new controls and nine existing rubric regressions. After the label freeze, `--requests --holdout` completed all eight local captures with zero inference. A human-authored faithful replay passed **8/8** fixture rubrics; a separate controlled refusal in the expected-empty case correctly exited 1 and preserved the seven prior passes plus the failed empty case. Both replay reports show cleanup passed and lifecycle `not_measured`. Temporary logs/recordings are `/tmp/threadkeeper-holdout-{requests,replay,refusal}.*`. These are harness checks only; the first live holdout and broader verification remain pending coordination on the final integrated source.
