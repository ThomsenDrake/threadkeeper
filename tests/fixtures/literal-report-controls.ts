// Predeclared synthetic controls for the literal report-attribution guard.
// These are unrelated to the seven-case learned taxonomy observation.
export const literalReportRepairControls = [
  { reporter: 'The build monitor', assertion: 'The Delta package is ready.', outsidePeriod: false },
  { reporter: 'Iris', assertion: 'The backup is complete.', outsidePeriod: false },
  { reporter: 'The nightly archive service', assertion: 'The amber snapshot is available', outsidePeriod: true },
] as const;

export const literalReportSkipControls = [
  { name: 'partial evidence', source: 'The build monitor reports: "The Delta package is ready."', statement: 'The Delta package is ready.', quote: 'Delta package is ready' },
  { name: 'paraphrased assertion', source: 'Iris reports: "The backup is complete."', statement: 'The backup has finished.', quote: 'The backup is complete.' },
  { name: 'ordinary user quote', source: 'Iris reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.', author_role: 'user', origin: 'user_explicit' },
  { name: 'assistant proposal', source: 'Iris reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.', origin: 'assistant_proposed' },
  { name: 'inferred interpretation', source: 'Iris reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.', memory_origin: 'inferred' },
  { name: 'unnamed reporter', source: 'Someone reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'pronoun reporter', source: 'She reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'unqualified role', source: 'The agent reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'multiple reporters', source: 'Iris and Rhea report: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'hypothetical wrapper', source: 'If Iris reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'negated wrapper', source: 'Iris does not report: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'surrounding disclaimer', source: 'An example only: Iris reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'trailing context', source: 'Iris reports: "The backup is complete." This is hypothetical.', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'two quoted claims', source: 'Iris reports: "The backup is complete." "The logs are ready."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'nested quote', source: 'Iris reports: "The file is named "backup"."', statement: 'The file is named "backup".', quote: 'The file is named "backup".' },
  { name: 'multiple sentences', source: 'Iris reports: "The backup is complete. The logs are ready."', statement: 'The backup is complete. The logs are ready.', quote: 'The backup is complete. The logs are ready.' },
  { name: 'compound assertion', source: 'Iris reports: "The backup is complete and the logs are ready."', statement: 'The backup is complete and the logs are ready.', quote: 'The backup is complete and the logs are ready.' },
  { name: 'negative assertion', source: 'Iris reports: "The backup is not complete."', statement: 'The backup is not complete.', quote: 'The backup is not complete.' },
  { name: 'hypothetical assertion', source: 'Iris reports: "The backup might be complete."', statement: 'The backup might be complete.', quote: 'The backup might be complete.' },
  { name: 'question assertion', source: 'Iris reports: "Is the backup complete?"', statement: 'Is the backup complete?', quote: 'Is the backup complete?' },
  { name: 'semicolon assertion', source: 'Iris reports: "The backup is complete; the logs are ready."', statement: 'The backup is complete; the logs are ready.', quote: 'The backup is complete; the logs are ready.' },
  { name: 'line break', source: 'Iris reports:\n"The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'non-ASCII reporter', source: 'Élodie reports: "The backup is complete."', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'non-ASCII assertion', source: 'Iris reports: "The café is ready."', statement: 'The café is ready.', quote: 'The café is ready.' },
  { name: 'curly quotation', source: 'Iris reports: “The backup is complete.”', statement: 'The backup is complete.', quote: 'The backup is complete.' },
  { name: 'reported attribution retained', source: 'Iris reports: "The backup is complete."', statement: 'According to Iris, the backup is complete.', quote: 'Iris reports: "The backup is complete."' },
] as const;

// Additional pre-implementation syntactic bounds requested by peer review.
export const literalReportBoundaryControls = [
  { reporter: `R${'a'.repeat(79)}`, assertion: 'The batch is ready.', statement: 'The batch is ready.', reject: true },
  { reporter: `R${'a'.repeat(80)}`, assertion: 'The batch is ready.', statement: 'The batch is ready.', reject: false },
  { reporter: 'Iris Rhea Nova', assertion: 'The batch is ready.', statement: 'The batch is ready.', reject: true },
  { reporter: 'Iris Rhea Nova Vega', assertion: 'The batch is ready.', statement: 'The batch is ready.', reject: false },
  { reporter: 'Iris  Rhea', assertion: 'The batch is ready.', statement: 'The batch is ready.', reject: false },
  { reporter: 'The imaginary monitor', assertion: 'The batch is ready.', statement: 'The batch is ready.', reject: false },
  { reporter: 'Iris', assertion: 'A'.repeat(4000), statement: 'A'.repeat(4000), reject: true },
  { reporter: 'Iris', assertion: `${'A'.repeat(4000)}.`, statement: 'A'.repeat(4000), reject: false },
] as const;
