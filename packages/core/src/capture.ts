import type { SourceEvent } from '@threadkeeper/contracts';

export function normalizeCaptureSource(event: SourceEvent, clientId: string) {
  return {
    capture_method: clientId === 'profile' ? 'profile_entry' : event.origin === 'agent_reported' ? 'client_summary' : event.capture_method ?? 'explicit_capture',
    occurred_at: event.occurred_at ?? null,
  };
}
