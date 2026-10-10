export const originLabels: Record<string, string> = {
  user_explicit: 'You said this',
  user_confirmed: 'Corrected by you',
  agent_reported: 'Reported by an agent',
  inferred: 'Inferred, not stated',
  assistant_proposed: 'Assistant suggestion, not accepted',
};

export const originDescriptions: Record<string, string> = {
  user_explicit: 'You stated this directly to an agent.',
  user_confirmed: 'You corrected this in Threadkeeper. Your wording is authoritative.',
  agent_reported: 'An agent reported this while working for you. You did not state it yourself.',
  inferred: 'Interpreted from conversation. You never said this outright.',
  assistant_proposed: 'An assistant proposed this. You have not accepted it; agents receive it labelled as a suggestion.',
};

export function sourceOriginLabel(source: { origin: string; capture_method?: string }): string {
  return source.origin === 'user_confirmed' && source.capture_method !== 'profile_correction' ? 'Previously confirmed by you' : originLabels[source.origin] || source.origin;
}

export function recallWording(memory: { statement: string; origin: string }): string {
  const statement = memory.statement.trim();
  switch (memory.origin) {
    case 'user_explicit': return `You said: ${statement}`;
    case 'user_confirmed': return `In your corrected wording: ${statement}`;
    case 'agent_reported': {
      const sentence = statement.charAt(0).toLowerCase() + statement.slice(1) + (/[.!?]$/.test(statement) ? '' : '.');
      return `An agent reported that ${sentence} You have not stated this yourself.`;
    }
    case 'inferred': return `Inferred from conversation, not stated by you: ${statement}`;
    case 'assistant_proposed': return `An assistant suggested: “${statement}” You have not accepted this suggestion.`;
    default: return statement;
  }
}
