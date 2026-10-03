# Assertion kind clarification

This increment is explicitly stacked on PR #17, starting at `fcce0db46dab1e77dce6ee6da6396eef58e013bd` and now integrating opaque-ID prerequisite `4478f8d3d3c6d1daf5ee184992c1ce9cc046d52b` plus checked PR #16 candidate `144dcbf742c5142684fc1af1fbaa6429f3198fa3` (native prerequisite `6122c79`). The runtime change clarifies existing kind semantics: a stated state, behavior or habit is a fact; a preference requires an expressed favored or desired option; a constraint states a limit, restriction or availability. Mere use or habit does not establish preference or a decision. Decisions and project context retain their original source attribution. This changes prompt guidance only, without keyword filters, new admission rules or model substitution.

The historical, descriptively-IDed v1 holdout's H6 was a faithful assertion with the wrong kind; H2 also had a kind mismatch alongside dialogue retention. These observations motivate the clarification but do not demonstrate its effectiveness. The prompt already prohibits question-only and dialogue records. This increment does not claim to fix those precision failures or H4's extra quoted commentary.

Before editing the prompt, seven fresh controls were frozen in commit `8e025891e736d00cece644ce2ef2f28b6ccaba1a`. Their [manifest](../deploy/provider-taxonomy-probe.ts) SHA-256 is `9c7a600b1883bce8359af7ac0f9471d0ef14fb7d66a98b9c3e5b00fbd5398077`. Semantic labels, exclusions and conservative anchored templates were independently reviewed before outputs. All case/event identifiers are category-free ordinals; runtime project IDs are also neutral. Labels and expected output metadata never enter provider context. Source roles remain legitimate evidence.

| Control | Required assertion and kind | Exclusions |
| --- | --- | --- |
| Stated behavior | Tuesday tram journey to the studio; fact | Inferred preference, exclusive transport or extra days |
| Favored option | Tram over driving for the studio journey; preference | Actual habit or inability to drive |
| Availability limit | Cannot enter studio before 11:30; constraint | Guaranteed later access, a date or timezone |
| Assertion inside question | Bicycle has a cargo rack; fact | Carrying capacity, agreement or dialogue question |
| Quoted project report | Deployment agent reports migration validation phase; fact **or** project_state | Completion, user confirmation or changed attribution |
| Irrelevant demonstration | Completed extraction, zero records | Apple preference or demonstration commentary |
| Assertion plus demonstration | Toolbox kept in hallway; fact | Demonstration preference/commentary or lost genuine assertion |

All nonempty controls require active records, the supplied self subject, exact source attribution and null effective time. Unknown source occurrence time remains null. The quoted report retains assistant role, agent_reported origin and client_summary capture provenance. The report kind union is intentional: both labels reasonably describe this attributed state under the contract.

`--taxonomy` reuses the existing capture/HTTP/two-MCP canonical comparison, source checks, safe failure reporting, observer and cleanup machinery. It is mutually exclusive with both v2 `--holdout` and offline-only `--holdout-v1`; the historical eleven-case corpus remains separate. It reports content, provenance and taxonomy dimensions alongside the strict score. Wrong kind with faithful content/attribution is a taxonomy-only mismatch; a failed job never passes the empty control. Extra or missing records fail content/count matching, with unassignable provenance/taxonomy marked not_measured rather than arbitrarily assigned. Finite templates can reject valid unlisted paraphrases; manual review must record these separately without changing the frozen score.

```sh
# Local fixtures only; these calls perform no provider inference.
node --import tsx deploy/provider-evaluation.ts --requests --taxonomy > /tmp/threadkeeper-taxonomy-requests.json
node --import tsx deploy/provider-evaluation.ts --replay /tmp/threadkeeper-taxonomy-fixture.json --taxonomy > /tmp/threadkeeper-taxonomy-replay.json

# Only after authorization, source review and a clean committed source:
NODE_USE_ENV_PROXY=1 MODEL_REASONING_EFFORT=none node --import tsx deploy/provider-evaluation.ts --live --taxonomy > /tmp/threadkeeper-taxonomy-result.json
```

The live path enforces exact `nvidia/Nemotron-3_5-Lightning` at `https://api.tokenfactory.nebius.com/v1/`, reasoning `none`, JSON-object mode, 4096 output tokens per request, at most **14 chats**, and **zero embeddings/model-list requests**. Report metadata identifies this manifest and exact live source commit independently of the old holdout. Observation completeness requires one or two attempts per case, matching model identity, preserved unsuccessful attempts and complete token accounting. All failures remain visible. The central lifecycle is explicitly not_measured.

No live taxonomy observation has been made. Typechecking and **22 focused tests** pass under Node **24.7.0** / pnpm **11.25.0**, including six new semantic, provenance, budget and failure-report controls. The selector integration at `a99d4b5` also passed typechecking and the same 22 focused tests. Logs are `/tmp/threadkeeper-direct/assertion-kinds-{typecheck,focused}.log` and `/tmp/threadkeeper-direct/assertion-kinds-v2-{typecheck,focused}.log`. On immutable combined source `9aef352347a38f680f7798e9a8d7227f8ef84250`, ordinary serial `pnpm check` passed **185/185 tests**, typechecking and production build; one subsequent `pnpm demo` invocation passed both full-text and hybrid modes. Logs are `/tmp/threadkeeper-direct/assertion-kinds-final-{check,demo}.log`. The same source generated all seven actual local requests: neutral project/event IDs, exact source text/roles, omitted unknown occurrence time and no grading labels. A manually authored faithful response replay passed **7/7 fixture rubrics** with all three dimensions passing. A separate controlled refusal in the empty case exited **1**, preserved the other six passes and reported the failed case with all dimensions not_measured. Both cleaned up and left lifecycle not_measured. Artifacts are `/tmp/threadkeeper-direct/assertion-kinds-{requests,fixture,replay,refusal-fixture,refusal,payload-audit}.json`, with distinct request/replay/refusal stderr files. These fixtures establish evaluator behavior, not learned quality. Independent source review found no actionable findings. Seven synthetic captures, including a demonstration pair, cannot establish broad quality; GPU, installed-host and native correction/forgetting checks remain separate gates. The old eight-case manifest and raw result remain unchanged.
