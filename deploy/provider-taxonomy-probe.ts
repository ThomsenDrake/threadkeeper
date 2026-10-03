import { createHash } from 'node:crypto';
import type { SourceEvent } from '../packages/contracts/src/index.ts';
import { DEFAULT_MODEL_BASE_URL, DEFAULT_MODEL_ID } from '../packages/providers/src/index.ts';
import type { EvaluationCase, ExpectedMemory } from './provider-evaluation-corpus.ts';

type TaxonomyExpected = ExpectedMemory & { accepted_kinds?: string[] };
export type TaxonomyCase = EvaluationCase & { expected: TaxonomyExpected[]; includes: string[]; excludes: string[] };
const event = (id: string, text: string, origin: SourceEvent['origin'] = 'user_explicit', author_role: SourceEvent['author_role'] = 'user'): SourceEvent => ({ id, text, origin, author_role });
const expected = (source_event_id: string, kind: string | string[], statement_patterns: string[], pattern: string, extra: Partial<TaxonomyExpected> = {}): TaxonomyExpected => ({
  source_event_id, ...(typeof kind === 'string' ? { kind } : { accepted_kinds: kind }), origin: 'user_explicit', status: 'active', effective_at: null,
  statement_patterns, pattern, ...extra,
});
const studio = '(?:my|the user\'s) studio';

// These seven independently audited semantic controls are frozen before the
// candidate prompt changes. Dates are unknown; no source timestamp is supplied.
// Assessment labels/templates must never enter the provider's input context.
export const taxonomyProbe: TaxonomyCase[] = [
  { id: 'case-01', events: [event('event-01', 'On Tuesdays, I ride the tram to my studio.')],
    expected: [expected('event-01', 'fact', [
      `On Tuesdays, (?:I ride|the user rides) the tram to ${studio}`,
      `(?:I ride|The user rides) the tram to ${studio} on Tuesdays`,
      `(?:I take|The user takes) the tram to ${studio} on Tuesdays`,
    ], 'tram', { and_patterns: ['Tuesdays', 'studio'] })],
    includes: ['Exactly one stated Tuesday travel habit, classified as fact. Preserve transport, destination and recurring weekday.'],
    excludes: ['A preference inferred from the habit, exclusive transport, travel on other days, or a newly chosen decision.'] },
  { id: 'case-02', events: [event('event-02', 'Taking the tram to my studio suits me better than driving.')],
    expected: [expected('event-02', 'preference', [
      `Taking the tram to ${studio} suits (?:me|the user) better than driving`,
      `(?:I prefer|The user prefers) taking the tram (?:rather than|over) driving to ${studio}`,
      `(?:I prefer|The user prefers) taking the tram to ${studio} (?:rather than|over) driving`,
    ], 'tram', { and_patterns: ['studio', 'driving', 'better than|rather than|over'] })],
    includes: ['Exactly one tram-over-driving preference for the studio journey. Preserve the comparison, subject and scope.'],
    excludes: ['An actual travel habit, inability to drive, an exclusive mode, or a preference for unrelated journeys.'] },
  { id: 'case-03', events: [event('event-03', 'I cannot enter my studio before 11:30.')],
    expected: [expected('event-03', 'constraint', [
      `(?:I cannot|The user cannot) (?:enter|access) ${studio} before 11:30`,
      `(?:I am|The user is) unable to (?:enter|access) ${studio} before 11:30`,
    ], 'studio', { and_patterns: ['before 11:30', 'cannot|unable'] })],
    includes: ['Exactly one entry restriction before 11:30, classified as constraint.'],
    excludes: ['Guaranteed access at or after 11:30, a reason for the restriction, a date, a timezone, or a mere preference.'] },
  { id: 'case-04', events: [event('event-04', 'Since my bicycle has a cargo rack, could it carry the samples?')],
    expected: [expected('event-04', 'fact', [
      `(?:My|The user's) bicycle has a cargo rack`,
      `(?:My|The user's) bicycle is equipped with a cargo rack`,
    ], 'bicycle', { and_patterns: ['cargo rack'] })],
    includes: ['Exactly one fact that the user\'s bicycle has a cargo rack. Retain the assertion independently of the question.'],
    excludes: ['Ability to carry samples, agreement to carry them, or a record describing/retaining the question.'] },
  { id: 'case-05', events: [event('event-05', 'The deployment agent reports: "The Elm migration is in the validation phase."', 'agent_reported', 'assistant')],
    expected: [expected('event-05', ['fact', 'project_state'], [
      'The deployment agent reports (?:that )?the Elm migration is in the validation phase',
      'The deployment agent reports: "The Elm migration is in the validation phase\\.?"',
      'According to the deployment agent, the Elm migration is in the validation phase',
    ], 'Elm migration', { origin: 'agent_reported', and_patterns: ['deployment agent', 'validation phase'] })],
    includes: ['Exactly one attributed deployment-agent report that the Elm migration is in validation phase.', 'Either fact or project_state is accepted because that taxonomy distinction is ambiguous under the existing contract.'],
    excludes: ['Completion, success, user confirmation, direct-user attribution, or rejection merely because the report is quoted.'] },
  { id: 'case-06', events: [event('event-06', 'This is a grammar exercise, not a statement about me: "I prefer tart apples."')], expected: [], empty: true,
    includes: ['Completed extraction with zero records.'],
    excludes: ['An apple preference, grammar-exercise commentary, or treating a failed job as a valid empty result.'] },
  { id: 'case-07', events: [event('event-07', 'I keep a toolbox in the hallway. Grammar example, not about me: "I prefer tart apples."')],
    expected: [expected('event-07', 'fact', [
      '(?:I keep|The user keeps) a toolbox in the hallway',
      '(?:My|The user\'s) toolbox is (?:kept |stored )?in the hallway',
    ], 'toolbox', { and_patterns: ['hallway'] })],
    includes: ['Exactly one fact that the user keeps a toolbox in the hallway.'],
    excludes: ['An apple preference, grammar-example commentary, or dropping the genuine assertion because another clause is a demonstration.'] },
];

export const taxonomyProbeManifest = {
  id: 'threadkeeper.assertion-kind-probe.v1', cases: taxonomyProbe,
  budget: { max_chat_requests: 14, max_embedding_requests: 0, max_output_tokens_per_request: 4096 },
  model: DEFAULT_MODEL_ID, base_url: DEFAULT_MODEL_BASE_URL, reasoning_effort: 'none',
  acceptance: 'All seven completed captures must match the fixed source-bound slots, accepted kind or kind union, provenance and canonical transports. Failed jobs never satisfy the empty control.',
  assessment_dimensions: {
    content: 'Preserve complete assertion, comparison, qualifier and scope; reject invented or irrelevant additional statements.',
    provenance: 'Require original attribution, exact supporting source evidence and declared status/effective time. Quotes may retain surrounding source context.',
    taxonomy: 'A faithful assertion with the wrong kind is a taxonomy-only mismatch; incorrect attribution is a provenance failure.',
  },
  manual_review: 'Inspect every statement and empty output against the frozen obligations. Preserve automated scores; report faithful unlisted paraphrases separately without changing labels or templates.',
  limitations: ['Seven synthetic captures include a demonstration pair, not seven independent assertions or a broad accuracy estimate.',
    'No measured fix for dialogue copying or irrelevant commentary is presumed from a taxonomy-only prompt change.',
    'No embeddings, native-container, correction/forgetting lifecycle, installed-host or GPU measurement.'],
};
export const taxonomyProbeSha256 = createHash('sha256').update(JSON.stringify(taxonomyProbeManifest)).digest('hex');
