# Assertion kind clarification

[PR #19](https://github.com/ThomsenDrake/threadkeeper/pull/19) is explicitly stacked on PR #17, starting at `fcce0db46dab1e77dce6ee6da6396eef58e013bd` and now integrating opaque-ID prerequisite `4478f8d3d3c6d1daf5ee184992c1ce9cc046d52b` plus checked PR #16 candidate `144dcbf742c5142684fc1af1fbaa6429f3198fa3` (native prerequisite `6122c79`) and final PR #17 evidence/docs head `4ed4664c9f9b654bf597811b4bdd512cd477018a`. The runtime change clarifies existing kind semantics: a stated state, behavior or habit is a fact; a preference requires an expressed favored or desired option; a constraint states a limit, restriction or availability. Mere use or habit does not establish preference or a decision. Decisions and project context retain their original source attribution. This changes prompt guidance only, without keyword filters, new admission rules or model substitution.

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

The single live observation is recorded below. Typechecking and **22 focused tests** pass under Node **24.7.0** / pnpm **11.25.0**, including six new semantic, provenance, budget and failure-report controls. The selector integration at `a99d4b5` also passed typechecking and the same 22 focused tests. Logs are `/tmp/threadkeeper-direct/assertion-kinds-{typecheck,focused}.log` and `/tmp/threadkeeper-direct/assertion-kinds-v2-{typecheck,focused}.log`. On immutable combined source `9aef352347a38f680f7798e9a8d7227f8ef84250`, ordinary serial `pnpm check` passed **185/185 tests**, typechecking and production build; one subsequent `pnpm demo` invocation passed both full-text and hybrid modes. Logs are `/tmp/threadkeeper-direct/assertion-kinds-final-{check,demo}.log`. The same source generated all seven actual local requests: neutral project/event IDs, exact source text/roles, omitted unknown occurrence time and no grading labels. A manually authored faithful response replay passed **7/7 fixture rubrics** with all three dimensions passing. A separate controlled refusal in the empty case exited **1**, preserved the other six passes and reported the failed case with all dimensions not_measured. Both cleaned up and left lifecycle not_measured. Artifacts are `/tmp/threadkeeper-direct/assertion-kinds-{requests,fixture,replay,refusal-fixture,refusal,payload-audit}.json`, with distinct request/replay/refusal stderr files. These fixtures establish evaluator behavior, not learned quality. Independent source review found no actionable findings. Seven synthetic captures, including a demonstration pair, cannot establish broad quality; GPU, installed-host and native correction/forgetting checks remain separate gates. The old eight-case manifest and raw result remain unchanged.


## One live taxonomy observation

The [unchanged raw report](measurements/nebius-assertion-kind-probe-v1.json) at immutable source `81c1159c5694e70434aadbe9bfa0c777380ec95a`, measured **2026-10-03 21:53:30.753 UTC**, exited **1** with **4/7 frozen rubrics passed**. All seven jobs completed, retaining seven original sources and admitting five records. **Seven direct HTTP 200 chats** to exact Nemotron used **10,639 prompt + 388 completion = 11,027 tokens**, zero reasoning; usage was complete and valid, totals reconciled, returned model identities matched and no embedding or model-list request occurred. Every case used one attempt. Request times were **843–33,787 ms**, which establishes no latency bound. Full canonical records matched through both MCP SDK clients and HTTP, independent source checks passed, unknown occurrence times stayed null and cleanup passed. Correction/forgetting remained not_measured.

| Control | Frozen result | Independent interpretation |
| --- | --- | --- |
| C1 Tuesday habit | Pass | Complete travel habit retained as fact. |
| C2 comparative preference | Pass | Studio journey comparison retained as preference. |
| C3 entry restriction | Fail, taxonomy only | Faithful limit and evidence; fact kind instead of constraint. |
| C4 fact inside question | Fail, omission | Completed empty output drops the explicit cargo-rack assertion. |
| C5 project report | Fail, explicit attribution | Validation-phase content and project_state kind survive, but the deployment-agent report framing is absent from statement and quote. |
| C6 demonstration only | Pass | Completed empty output excludes the irrelevant example. |
| C7 fact plus demonstration | Pass | Toolbox fact survives and the example is excluded. |

The C5 canonical source, record and evidence still preserve agent_reported origin, assistant role and client_summary capture method. The failure is loss of explicit report framing; it is not source-identity corruption, promotion to user origin, completion or confirmation. All five admitted records retain null effective time. [Independent qualitative review](measurements/nebius-assertion-kind-probe-v1-assessment.json) by the author, root and a separate reviewer found no template-only false negatives. The strict score and original manual-review-required field remain untouched; completed review is recorded in the companion assessment only.

Raw SHA-256: `521c48ff674a4e6f83cbf826645c7f389dbde7dae185ed9e0e6e28daf937f7fd`, **40,400 bytes**. Private original output/stderr: `/tmp/threadkeeper-direct/taxonomy-live-81c1159.json` and `.stderr`; audit: `taxonomy-live-81c1159-audit.json`. Before this single authorized run, key presence and exact configuration were verified without printing credentials. The integration from checked `9aef352` to measured `81c1159` changed documentation/evidence only: all **112** application, provider, evaluator, test and configuration files were byte-identical. Frozen labels remain byte-identical to `8e02589`. No prompt, model, label, template or score changed after inference and no retry sought a green result.

The generic clarification did not make the probe pass. These seven fresh controls were not measured before the change, so the correct habit/preference examples do not establish a causal improvement. Completeness, explicit attribution and kind consistency remain quality limitations. This measurement establishes only PGlite extraction/full-text recall; native containers, learned embeddings, correction/forgetting, installed-host selection and GPU parity retain their own checks. No further calls on this fixed set are scheduled.
