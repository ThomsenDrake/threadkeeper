import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

type Memory = {
  id: string; statement: string; subject: string; project_id: string | null;
  kind: string; origin: string; status: string; revision: number;
  effective_at: string | null; created_at: string; updated_at: string; authoritative?: boolean;
};
type Source = {
  id: string; event_id: string; client_id: string | null; text: string;
  author_role: string; origin: string; occurred_at: string | null; recorded_at: string;
  project_id: string | null; subject: string; capture_method?: string;
};
type Evidence = { source_id: string; quote: string; revision: number };
type Revision = { revision: number; statement: string; origin: string; status: string; effective_at: string | null; created_at: string; editor_client_id: string | null; extractor?: string | null };
type Detail = { memory: Memory; sources: Source[]; evidence?: Evidence[]; revisions: Revision[] };
type Client = { id: string; name: string; permissions: string[]; projects: string[] | null; created_at?: string; last_used_at?: string | null; revoked_at?: string | null };
type CaptureSettings = { paused: boolean; version: number };
type CaptureStatus = {
  capture_id: string; client_id: string; project_id: string | null; subject: string; created_at: string;
  status: 'saved' | 'pending' | 'processing' | 'complete' | 'failed' | 'cancelled';
  source_ids: string[]; memory_ids: string[];
  job: { id: string; status: string; attempts: number; started_at: string | null; completed_at: string | null; error_code: string | null; accepted: number | null; skipped: number | null } | null;
  can_retry: boolean; retry_unavailable_reason: string | null;
};
type CaptureReceipt = { capture_id: string; status: string; received_at: string };
type Page = 'memories' | 'captures' | 'connections' | 'portability';
type Notice = { text: string; type: 'success' | 'error' };

const originLabels: Record<string, string> = {
  user_explicit: 'Direct user statement', user_confirmed: 'User confirmed', assistant_proposed: 'Assistant proposal',
  agent_reported: 'Client-reported context', inferred: 'Model inference',
};
const statusLabels: Record<string, string> = { active: 'Active', candidate: 'Needs review', disputed: 'Disputed', superseded: 'Superseded', dismissed: 'Dismissed' };
const kindLabels: Record<string, string> = { fact: 'Fact', preference: 'Preference', decision: 'Decision', constraint: 'Constraint', project_state: 'Project state' };
const captureMethodLabels: Record<string, string> = { explicit_capture: 'Explicit capture', client_summary: 'Client summary', profile_entry: 'Profile entry', profile_correction: 'Profile correction', profile_confirmation: 'Profile confirmation', import: 'Import' };
const captureStatusLabels: Record<CaptureStatus['status'], string> = { saved: 'Saved', pending: 'Pending', processing: 'Processing', complete: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
const captureStatusDescriptions: Record<CaptureStatus['status'], string> = {
  saved: 'The source is saved. No extraction job is available for this capture.',
  pending: 'The source is saved and waiting for an extraction worker. Processing starts when a configured worker is available.',
  processing: 'An extraction worker has claimed this capture. Results are not yet complete.',
  complete: 'This capture has finished. Current memories and source evidence are linked below.',
  failed: 'Extraction could not finish. Your remaining source evidence is still available below.',
  cancelled: 'Processing was cancelled. Deleted evidence and memories cannot be restored by retrying.',
};
const retryUnavailableMessages: Record<string, string> = {
  owner_retry_required: 'Only the profile owner can retry extraction.',
  extraction_not_requested: 'This capture did not request extraction.',
  job_unavailable: 'The extraction job is no longer available.',
  sources_unavailable: 'The source evidence is no longer available for extraction.',
  job_not_failed: 'Only failed extraction can be retried.',
};
const pageLabels: Record<Page, string> = { memories: 'Your memories', captures: 'Captures', connections: 'Connections', portability: 'Import & export' };
const pageCopy: Record<Page, { eyebrow: string; title: string; description: string }> = {
  memories: { eyebrow: 'THE THREAD YOU KEEP', title: 'Your memory, on your terms.', description: 'Review what is remembered, where it came from, and what needs to change.' },
  captures: { eyebrow: 'FROM SOURCE TO MEMORY', title: 'Follow your captures.', description: 'Inspect current processing, open source evidence, and retry failed extraction.' },
  connections: { eyebrow: 'CONTEXT, WITH PERMISSION', title: 'Client credentials.', description: 'Give each chatbot or coding agent only the access it needs.' },
  portability: { eyebrow: 'TAKE YOUR CONTEXT WITH YOU', title: 'Memory without lock-in.', description: 'Export your sources and memories, or bring them into this deployment.' },
};
const readableDate = (date?: string | null) => date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)) : 'Not supplied';
const errorMessages: Record<string, string> = {
  invalid_credentials: 'The email or password is incorrect.',
  rate_limit: 'Too many sign-in attempts. Please try again in a minute.',
  validation: 'Some details are invalid. Check your entries and try again.',
  unauthorized: 'Your session has ended. Sign in again to continue.',
  scope_denied: 'This client does not have access to the requested scope.',
  internal_error: 'The service could not complete this request. Please try again.',
  capture_not_found: 'This capture is no longer available.',
  source_not_found: 'This source is no longer available. It may have been forgotten.',
  memory_not_found: 'This memory is no longer available. Refresh to see the current records.',
  attempt_conflict: 'This extraction attempt has changed. Refresh its status before retrying.',
  retry_unavailable: 'This capture can no longer be retried. Its current status has been refreshed.',
  revision_conflict: 'This memory has changed. Refresh its current revision before reviewing again.',
  review_unavailable: 'This memory is no longer waiting for review.',
  review_required: 'Use the candidate review actions to confirm this memory. Dismissed memories remain available for inspection and deletion.',
  capture_paused: 'New captures are paused. Resume capture in Connections before saving more context.',
  capture_settings_conflict: 'Capture settings changed elsewhere. Review the current setting before trying again.',
};

const walkthroughCapture = JSON.stringify({
  idempotency_key: 'first-context-v1', project_id: null, subject: 'self',
  events: [{ id: 'first-context-note', text: 'Use short paragraphs in my writing.', author_role: 'user', origin: 'user_explicit', capture_method: 'explicit_capture' }],
  explicit_memories: [{ statement: 'Use short paragraphs in my writing.', kind: 'preference', source_event_id: 'first-context-note', quote: 'Use short paragraphs in my writing.', origin: 'user_explicit' }],
}, null, 2);
const walkthroughRecall = JSON.stringify({ query: 'short paragraphs', project_id: null, subject: 'self', limit: 10 }, null, 2);

class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof result.error === 'string' ? result.error : result.error?.message || result.message || `Request failed (${response.status})`;
    throw new ApiError(errorMessages[reason] || reason, response.status, reason);
  }
  return result as T;
}

function validatedCaptureSettings(result: CaptureSettings): CaptureSettings {
  if (typeof result.paused !== 'boolean' || !Number.isSafeInteger(result.version) || result.version < 0) throw new Error('Capture controls returned an unreadable response. Refresh before trying again.');
  return result;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    memories: <><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h6" /></>,
    captures: <><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 8h8M8 12h5M8 16h3" /></>,
    connections: <><path d="M9 8h6M9 16h6M6 5v14M18 5v14" /><circle cx="6" cy="8" r="2" /><circle cx="18" cy="16" r="2" /></>,
    portability: <><path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5" /></>,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4 10-10" />,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.memories}</svg>;
}

function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true"><span /></span><span>threadkeeper<span className="brand-dot">.</span></span></div>;
}

function CopyValue({ label, value, rows = 3, disabled = false, copyLabel }: { label: string; value: string; rows?: number; disabled?: boolean; copyLabel?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState('');
  useEffect(() => setMessage(''), [value, disabled]);
  return <div className="copy-field"><label>{label}<textarea ref={ref} aria-label={label} readOnly rows={rows} value={value} className="token-value" onFocus={event => event.currentTarget.select()} /></label><div className="copy-actions"><button className="button secondary" type="button" disabled={disabled || !value} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setMessage(`${label} copied.`); }
    catch { ref.current?.focus(); ref.current?.select(); setMessage('Text selected. Use your device’s copy command.'); }
  }}>{copyLabel || `Copy ${label.toLowerCase()}`}</button><span className="fine-print" role="status">{message}</span></div></div>;
}

function Modal({ title, description, onClose, children }: { title: string; description?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>('input,textarea,button,select')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab' && dialog) {
        const elements = Array.from(dialog.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href]')).filter(el => !el.hasAttribute('disabled'));
        const first = elements[0]; const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
      <button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog"><Icon name="close" /></button>
      <h2 id="modal-title">{title}</h2>{description && <p className="muted">{description}</p>}{children}
    </div>
  </div>;
}

export default function App() {
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [page, setPage] = useState<Page>('memories');
  const [memories, setMemories] = useState<Memory[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [captureSettings, setCaptureSettings] = useState<CaptureSettings | null>(null);
  const [captureSettingsLoading, setCaptureSettingsLoading] = useState(true);
  const [captureSettingsError, setCaptureSettingsError] = useState<string | null>(null);
  const [captureSettingsBusy, setCaptureSettingsBusy] = useState(false);
  const [mcpEndpoint, setMcpEndpoint] = useState<string | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [settingsRefreshVersion, setSettingsRefreshVersion] = useState(0);
  const [clientScope, setClientScope] = useState<'all' | 'selected'>('all');
  const [walkthroughAuthorized, setWalkthroughAuthorized] = useState(false);
  const [filters, setFilters] = useState({ query: '', subject: '', project_id: '', source: '', status: 'active' });
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editDate, setEditDate] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reviewingAction, setReviewingAction] = useState<'confirm' | 'dismiss' | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [modal, setModal] = useState<'capture' | 'client' | null>(null);
  const [token, setToken] = useState<{ value: string; name: string } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [exportBusy, setExportBusy] = useState(false);
  const [importText, setImportText] = useState('');
  const [importName, setImportName] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [pendingRevocation, setPendingRevocation] = useState<string | null>(null);
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [captureMode, setCaptureMode] = useState<'explicit' | 'extract'>('explicit');
  const [captures, setCaptures] = useState<CaptureStatus[]>([]);
  const [capturePages, setCapturePages] = useState(1);
  const [nextCaptureOffset, setNextCaptureOffset] = useState<number | null>(null);
  const [capturesLoading, setCapturesLoading] = useState(false);
  const [capturesError, setCapturesError] = useState<string | null>(null);
  const [capturesUpdatedAt, setCapturesUpdatedAt] = useState<string | null>(null);
  const [captureRefreshVersion, setCaptureRefreshVersion] = useState(0);
  const [retryingCapture, setRetryingCapture] = useState<string | null>(null);
  const [captureReceipt, setCaptureReceipt] = useState<CaptureReceipt | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [sourceRefreshVersion, setSourceRefreshVersion] = useState(0);
  const authGeneration = useRef(0);
  const detailRequest = useRef(0);
  const memoryPanel = useRef<HTMLElement>(null);
  const captureRequest = useRef<{ fingerprint: string; key: string; sourceId: string; occurredAt: string } | null>(null);

  const clearOwnerState = () => {
    authGeneration.current++;
    setUser(null); setSelected(null); setMemories([]); setClients([]); setToken(null); setModal(null);
    setClientsError(null); setClientsLoading(false); setCaptureSettings(null); setCaptureSettingsError(null); setCaptureSettingsLoading(true); setCaptureSettingsBusy(false);
    setMcpEndpoint(null); setConnectionError(null); setConnectionLoading(true); setWalkthroughAuthorized(false);
    setCaptures([]); setCaptureReceipt(null); setCapturePages(1); setNextCaptureOffset(null);
    setCapturesUpdatedAt(null); setCapturesError(null); setCapturesLoading(false); setRetryingCapture(null);
    setSourceId(null); setSource(null); setSourceError(null); setSourceLoading(false);
    setBusy(false); setDetailError(null); captureRequest.current = null;
    detailRequest.current++; setSelectedMemoryId(null); setDetailLoading(false); setReviewError(null); setReviewingAction(null); setDismissing(false); setEditing(false); setDeleting(false);
  };
  const informError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) clearOwnerState();
    setNotice({ type: 'error', text: error instanceof Error ? error.message : 'The request could not be completed.' });
  };
  const refresh = () => setRefreshVersion(v => v + 1);
  const captureUnavailable = !captureSettings || captureSettingsLoading || captureSettingsBusy || !!captureSettingsError || captureSettings.paused;
  const openCapture = () => {
    if (captureUnavailable) { setPage('connections'); return; }
    setCaptureMode('explicit'); setModal('capture');
  };
  const openClient = () => { setClientScope('all'); setModal('client'); };
  const closeMemory = () => { detailRequest.current++; setSelected(null); setSelectedMemoryId(null); setDetailLoading(false); setDetailError(null); setReviewError(null); setEditing(false); setDeleting(false); setDismissing(false); };
  const closeMemoryRef = useRef(closeMemory);
  closeMemoryRef.current = closeMemory;

  useEffect(() => {
    if (!selectedMemoryId) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = memoryPanel.current;
    panel?.querySelector<HTMLElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMemoryRef.current();
      if (event.key === 'Tab' && panel) {
        const elements = Array.from(panel.querySelectorAll<HTMLElement>('button,input,textarea,select,a[href],summary')).filter(element => !element.hasAttribute('disabled') && element.getClientRects().length > 0);
        const first = elements[0]; const last = elements[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [selectedMemoryId]);

  useEffect(() => {
    api<{ user: { email: string } }>('/auth/me').then(result => setUser(result.user)).catch(error => {
      if (!(error instanceof ApiError) || error.status !== 401) informError(error);
    }).finally(() => setLoadingAuth(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setClientsLoading(true); setClientsError(null);
    api<{ clients: Client[] }>('/clients', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setClients(result.clients); }).catch(error => {
      if (controller.signal.aborted) return;
      setClientsError(error instanceof Error ? error.message : 'Unable to load client credentials.');
      if (error instanceof ApiError && error.status === 401) informError(error);
    }).finally(() => { if (!controller.signal.aborted) setClientsLoading(false); });
    return () => controller.abort();
  }, [user, refreshVersion]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    setCaptureSettingsLoading(true); setCaptureSettingsError(null); setConnectionLoading(true); setConnectionError(null);
    void Promise.allSettled([
      api<CaptureSettings>('/settings/capture', { signal: controller.signal }).then(validatedCaptureSettings).then(result => { if (!controller.signal.aborted) setCaptureSettings(current => current && current.version > result.version ? current : result); }).catch(error => {
        if (controller.signal.aborted) return;
        setCaptureSettingsError(error instanceof Error ? error.message : 'Unable to load capture controls.');
        if (error instanceof ApiError && error.status === 401) informError(error);
      }).finally(() => { if (!controller.signal.aborted) setCaptureSettingsLoading(false); }),
      api<{ mcp_endpoint: string }>('/settings/connection', { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setMcpEndpoint(result.mcp_endpoint); }).catch(error => {
        if (controller.signal.aborted) return;
        setConnectionError(error instanceof Error ? error.message : 'Unable to load the connection endpoint.');
        if (error instanceof ApiError && error.status === 401) informError(error);
      }).finally(() => { if (!controller.signal.aborted) setConnectionLoading(false); }),
    ]);
    return () => controller.abort();
  }, [user, settingsRefreshVersion]);

  useEffect(() => {
    if (!user) return;
    const refreshSettings = () => setSettingsRefreshVersion(value => value + 1);
    window.addEventListener('focus', refreshSettings);
    return () => window.removeEventListener('focus', refreshSettings);
  }, [user]);

  useEffect(() => {
    if (!user || page !== 'memories') return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setListLoading(true);
      const query = new URLSearchParams([...Object.entries(filters).filter(([,value]) => value), ['limit', '100']]);
      api<{ memories: Memory[] }>(`/memories?${query}`, { signal: controller.signal }).then(result => setMemories(result.memories)).catch(error => {
        if (error instanceof Error && error.name !== 'AbortError') informError(error);
      }).finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    }, 150);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [user, page, filters, refreshVersion]);

  useEffect(() => {
    if (!user || page !== 'captures') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setCapturesLoading(true); setCapturesError(null);
      try {
        let offset: number | null = 0;
        const current: CaptureStatus[] = [];
        for (let count = 0; count < capturePages && offset !== null; count++) {
          const result: { captures: CaptureStatus[]; next_offset: number | null } = await api(`/captures?limit=50&offset=${offset}`, { signal: controller.signal });
          current.push(...result.captures); offset = result.next_offset;
        }
        if (controller.signal.aborted) return;
        const unique = [...new Map(current.map(item => [item.capture_id, item])).values()];
        setCaptures(unique); setNextCaptureOffset(offset); setCapturesUpdatedAt(new Date().toISOString());
        if (unique.some(item => item.status === 'pending' || item.status === 'processing')) timer = setTimeout(load, 4000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setCapturesError(error instanceof Error ? error.message : 'Unable to load captures.');
        if (error instanceof ApiError && error.status === 401) informError(error);
      } finally { if (!controller.signal.aborted) setCapturesLoading(false); }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [user, page, capturePages, refreshVersion, captureRefreshVersion]);

  useEffect(() => {
    if (!user || !sourceId) return;
    const controller = new AbortController();
    setSource(null); setSourceError(null); setSourceLoading(true);
    api<Source>(`/sources/${encodeURIComponent(sourceId)}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setSource(result);
    }).catch(error => {
      if (controller.signal.aborted) return;
      setSourceError(error instanceof Error ? error.message : 'Unable to load this source.');
      if (error instanceof ApiError && error.status === 401) informError(error);
    }).finally(() => { if (!controller.signal.aborted) setSourceLoading(false); });
    return () => controller.abort();
  }, [user, sourceId, sourceRefreshVersion]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoginError(''); setLoginBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ user: { email: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      authGeneration.current++; setUser(result.user); setNotice(null);
    } catch (error) { setLoginError(error instanceof Error ? error.message : 'Sign-in failed.'); }
    finally { setLoginBusy(false); }
  }

  async function openMemory(memory: Pick<Memory, 'id'>) {
    const generation = authGeneration.current;
    const request = ++detailRequest.current;
    setSelectedMemoryId(memory.id); setSelected(null); setDetailLoading(true); setDetailError(null); setReviewError(null); setEditing(false); setDeleting(false); setDismissing(false);
    try {
      const detail = await api<Detail>(`/memories/${encodeURIComponent(memory.id)}`);
      if (generation === authGeneration.current && request === detailRequest.current) setSelected(detail);
    } catch (error) {
      if (generation !== authGeneration.current || request !== detailRequest.current) return;
      setDetailError(error instanceof Error ? error.message : 'Unable to load this memory.');
      if (error instanceof ApiError && error.status === 401) informError(error);
    } finally { if (generation === authGeneration.current && request === detailRequest.current) setDetailLoading(false); }
  }

  async function reviewMemory(action: 'confirm' | 'dismiss', withEdits = false) {
    if (!selected || selected.memory.status !== 'candidate' || busy) return;
    const memory = selected.memory;
    const generation = authGeneration.current;
    const request = detailRequest.current;
    const current = () => generation === authGeneration.current && request === detailRequest.current;
    setBusy(true); setReviewingAction(action); setReviewError(null);
    try {
      await api(`/memories/${encodeURIComponent(memory.id)}/review`, { method: 'POST', body: JSON.stringify({
        action, expected_revision: memory.revision,
        ...(withEdits ? { statement: editText.trim(), ...(editDate ? { effective_at: new Date(editDate).toISOString() } : {}) } : {}),
      }) });
      if (generation !== authGeneration.current) return;
      refresh();
      setNotice({ type: 'success', text: action === 'confirm' ? 'Confirmed with your separate user-authored evidence. Fresh recall uses this confirmed memory.' : 'Candidate dismissed. Its evidence and history remain available; fresh default recall excludes it.' });
      if (!current()) return;
      setSelected(null); setDetailLoading(true); setEditing(false); setDismissing(false);
      try {
        const detail = await api<Detail>(`/memories/${encodeURIComponent(memory.id)}`);
        if (current()) setSelected(detail);
      } catch (error) {
        if (!current()) return;
        setDetailError('Your review was saved. Refresh this memory to load its current evidence and history.');
        if (error instanceof ApiError && error.status === 401) informError(error);
      }
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (error instanceof ApiError && error.status === 401) { informError(error); return; }
      if (!current()) return;
      setReviewError(error instanceof Error ? error.message : 'This review could not be saved. Try again or refresh the memory.');
      if (error instanceof ApiError && error.status === 409) {
        setSelected(null); setDetailLoading(true); setEditing(false); setDismissing(false);
        try {
          const detail = await api<Detail>(`/memories/${encodeURIComponent(memory.id)}`);
          if (current()) { setSelected(detail); setReviewError('This memory changed. Its current revision is loaded. Review it before choosing an action again.'); refresh(); }
        } catch (refreshError) {
          if (!current()) return;
          setDetailError('Unable to load the current revision. Refresh this memory before reviewing again.');
          if (refreshError instanceof ApiError && refreshError.status === 401) informError(refreshError);
        }
      }
    } finally {
      if (generation === authGeneration.current) { setBusy(false); setReviewingAction(null); if (request === detailRequest.current) setDetailLoading(false); }
    }
  }

  async function editMemory(event: FormEvent) {
    event.preventDefault(); if (!selected) return; setBusy(true);
    try {
      await api(`/memories/${encodeURIComponent(selected.memory.id)}`, { method: 'PATCH', body: JSON.stringify({ statement: editText.trim(), expected_revision: selected.memory.revision, ...(editDate ? { effective_at: new Date(editDate).toISOString() } : {}) }) });
      const detail = await api<Detail>(`/memories/${encodeURIComponent(selected.memory.id)}`);
      setSelected(detail); setEditing(false); refresh();
      setNotice({ type: 'success', text: 'Correction saved. Fresh client retrieval uses this revision.' });
    } catch (error) {
      informError(error);
      if (error instanceof ApiError && error.status === 409) {
        try { setSelected(await api<Detail>(`/memories/${encodeURIComponent(selected.memory.id)}`)); } catch { /* Keep the edit visible for recovery. */ }
        setNotice({ type: 'error', text: 'Someone changed this memory. The current revision has been loaded. Review it before saving again.' });
      }
    } finally { setBusy(false); }
  }

  async function deleteMemory() {
    if (!selected) return; setBusy(true);
    try {
      await api(`/memories/${encodeURIComponent(selected.memory.id)}`, { method: 'DELETE', body: JSON.stringify({ expected_revision: selected.memory.revision }) });
      closeMemory(); refresh();
      setNotice({ type: 'success', text: 'Deleted. This memory and affected evidence are removed from future retrieval.' });
    } catch (error) { informError(error); } finally { setBusy(false); }
  }

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (captureUnavailable) { setNotice({ type: 'error', text: 'Capture is unavailable. Check the capture controls in Connections before saving.' }); return; }
    setBusy(true);
    const generation = authGeneration.current;
    const form = new FormData(event.currentTarget);
    const text = String(form.get('statement') || '').trim();
    const subject = String(form.get('subject') || '').trim() || 'self';
    const project = String(form.get('project') || '').trim() || null;
    const fingerprint = JSON.stringify([text, subject, project, form.get('kind'), captureMode]);
    if (!captureRequest.current || captureRequest.current.fingerprint !== fingerprint) captureRequest.current = { fingerprint, key: crypto.randomUUID(), sourceId: crypto.randomUUID(), occurredAt: new Date().toISOString() };
    const { key, sourceId, occurredAt } = captureRequest.current;
    try {
      const result = await api<{ capture_id: string; status: string }>('/capture', { method: 'POST', body: JSON.stringify({
        idempotency_key: key, project_id: project, subject,
        events: [{ id: sourceId, text, author_role: 'user', origin: 'user_explicit', capture_method: 'profile_entry', occurred_at: occurredAt }],
        ...(captureMode === 'explicit' ? { explicit_memories: [{ statement: text, quote: text, source_event_id: sourceId, kind: form.get('kind'), origin: 'user_explicit', subject }] } : {}),
      }) });
      if (generation !== authGeneration.current) return;
      setModal(null); captureRequest.current = null;
      setCaptureReceipt({ capture_id: result.capture_id, status: result.status, received_at: new Date().toISOString() });
      if (result.status === 'pending') { setPage('captures'); setCapturePages(1); }
      refresh(); setNotice({ type: 'success', text: result.status === 'pending' ? 'Source saved. Check Captures for current processing status.' : 'Saved as your direct statement, with its source evidence.' });
    } catch (error) {
      if (generation === authGeneration.current) {
        informError(error);
        if (error instanceof ApiError && error.code === 'capture_paused') setSettingsRefreshVersion(value => value + 1);
      }
    }
    finally { if (generation === authGeneration.current) setBusy(false); }
  }

  async function retryCapture(item: CaptureStatus) {
    if (!item.can_retry || !item.job || retryingCapture) return;
    const generation = authGeneration.current;
    setRetryingCapture(item.capture_id);
    try {
      const updated = await api<CaptureStatus>(`/captures/${encodeURIComponent(item.capture_id)}/retry`, { method: 'POST', body: JSON.stringify({ expected_attempts: item.job.attempts }) });
      if (generation !== authGeneration.current) return;
      setCaptures(current => current.map(capture => capture.capture_id === updated.capture_id ? updated : capture));
      setNotice({ type: 'success', text: 'Retry queued. The existing source will be processed when a configured worker is available.' });
    } catch (error) {
      if (generation !== authGeneration.current) return;
      informError(error);
      if (error instanceof ApiError && error.status === 409) {
        try {
          const updated = await api<CaptureStatus>(`/captures/${encodeURIComponent(item.capture_id)}`);
          if (generation !== authGeneration.current) return;
          setCaptures(current => current.map(capture => capture.capture_id === updated.capture_id ? updated : capture));
        } catch (refreshError) { if (generation === authGeneration.current) informError(refreshError); }
      }
    } finally { if (generation === authGeneration.current) { setRetryingCapture(null); setCaptureRefreshVersion(value => value + 1); } }
  }

  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); const form = new FormData(event.currentTarget);
    const generation = authGeneration.current;
    try {
      const projects = String(form.get('projects') || '').split(',').map(item => item.trim()).filter(Boolean);
      const permissions = ['read', ...(form.get('capture') ? ['capture'] : [])];
      const result = await api<{ client: Client; token: string }>('/clients', { method: 'POST', body: JSON.stringify({ name: form.get('name'), permissions, projects: form.get('scope') === 'all' ? null : projects }) });
      if (generation !== authGeneration.current) return;
      setModal(null); setToken({ value: result.token, name: result.client.name }); refresh();
    } catch (error) { if (generation === authGeneration.current) informError(error); }
    finally { if (generation === authGeneration.current) setBusy(false); }
  }

  async function toggleCapture() {
    if (!captureSettings || captureSettingsLoading || captureSettingsBusy || captureSettingsError) return;
    const generation = authGeneration.current;
    const paused = !captureSettings.paused;
    setCaptureSettingsBusy(true);
    try {
      const updated = validatedCaptureSettings(await api<CaptureSettings>('/settings/capture', { method: 'PATCH', body: JSON.stringify({ paused, expected_version: captureSettings.version }) }));
      if (generation !== authGeneration.current) return;
      setCaptureSettings(current => current && current.version > updated.version ? current : updated);
      setNotice({ type: 'success', text: paused ? 'New captures paused for all clients and the profile. Existing context remains available.' : 'New captures resumed. Clients still need capture permission and your authorization.' });
    } catch (error) {
      if (generation !== authGeneration.current) return;
      // A failed or unreadable response can follow a committed mutation. Stop
      // presenting the old state as current until canonical settings are read.
      setCaptureSettings(null);
      informError(error);
      setSettingsRefreshVersion(value => value + 1);
    } finally { if (generation === authGeneration.current) setCaptureSettingsBusy(false); }
  }

  async function revokeClient(id: string) {
    setBusy(true);
    try { await api(`/clients/${encodeURIComponent(id)}`, { method: 'DELETE' }); setPendingRevocation(null); refresh(); setNotice({ type: 'success', text: 'Access revoked. Existing memories are kept.' }); }
    catch (error) { informError(error); } finally { setBusy(false); }
  }

  async function downloadExport() {
    setExportBusy(true);
    try {
      const response = await fetch('/api/export', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Export failed (${response.status}).`);
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `threadkeeper-export-${new Date().toISOString().slice(0, 10)}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice({ type: 'success', text: 'Export downloaded. Store it somewhere private.' });
    } catch (error) { informError(error); } finally { setExportBusy(false); }
  }

  async function importBundle() {
    setImportBusy(true);
    try {
      const bundle = JSON.parse(importText);
      await api('/import', { method: 'POST', body: JSON.stringify(bundle) });
      setImportText(''); setImportName(''); refresh();
      setNotice({ type: 'success', text: 'Import completed. Review the restored memories and sources. Client grants are not restored.' });
    } catch (error) { informError(error); } finally { setImportBusy(false); }
  }

  const clientName = (id: string | null) => !id || id === 'profile' ? 'Profile' : clients.find(client => client.id === id)?.name || id;
  const activeClients = clients.filter(client => !client.revoked_at);

  if (loadingAuth) return <div className="loading-screen"><Brand /><p>Opening your profile…</p></div>;

  if (!user) return <div className="login-layout">
    <div className="login-story"><Brand /><div><span className="eyebrow">YOUR CONTEXT. YOUR CONTROL.</span><h1>Switch agents.<br /><em>Keep the thread.</em></h1><p>One personal memory, wherever you work. See its sources. Correct what changes. Forget what you choose.</p><div className="thread-art" aria-hidden="true"><span /><span /><span /><span /></div></div><span className="login-foot">Portable context · Local controls</span></div>
    <main className="login-main"><form className="login-card" onSubmit={login}><span className="small-icon"><Icon name="lock" /></span><h2>Your memory profile</h2><p className="muted">Sign in with your deployment’s local account.</p>
      {notice && <div className={`notice ${notice.type}`} role="alert">{notice.text}</div>}
      <label>Email<input name="email" type="email" autoComplete="username" required placeholder="you@example.com" /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {loginError && <p className="field-error" role="alert">{loginError}</p>}
      <button className="button primary wide" disabled={loginBusy}>{loginBusy ? 'Signing in…' : 'Sign in'}</button><p className="login-helper">Your account is managed by the operator of this deployment.</p>
    </form></main>
  </div>;

  return <div className="app-shell">
    <aside className="sidebar"><Brand /><div className="workspace-label">PERSONAL CONTEXT</div><nav aria-label="Main navigation">{(['memories', 'captures', 'connections', 'portability'] as Page[]).map(item => <button key={item} className={`nav-item ${page === item ? 'selected' : ''}`} aria-current={page === item ? 'page' : undefined} onClick={() => { setPage(item); closeMemory(); }}><Icon name={item} />{pageLabels[item]}{item === 'memories' && <span className="nav-count">{memories.length}</span>}</button>)}</nav>
      <div className="sidebar-note"><span className="status-dot" />You own the memory.<p>Connected clients request context. You decide what stays.</p></div>
      <div className="account"><div className="avatar">{user.email[0].toUpperCase()}</div><div><span className="account-label">Local account</span><span className="account-email" title={user.email}>{user.email}</span></div><button className="signout" onClick={async () => { try { await api('/auth/logout', { method: 'POST' }); clearOwnerState(); } catch (error) { informError(error); } }}>Sign out</button></div>
    </aside>
    <main className="main-content">
      <div className="topbar"><span>Profile <span className="breadcrumb-slash">/</span> {pageLabels[page]}</span><span className="topbar-detail"><Icon name="lock" />Private to your account</span></div>
      <div className="page-content">
        <header className="page-header"><div><span className="eyebrow">{pageCopy[page].eyebrow}</span><h1>{pageCopy[page].title}</h1><p>{pageCopy[page].description}</p></div>
          {(page === 'memories' || page === 'captures') && <button className="button primary" onClick={openCapture} disabled={captureUnavailable}><Icon name="plus" />{page === 'captures' ? 'Add context' : 'Add memory'}</button>}{page === 'connections' && <button className="button primary" onClick={openClient}><Icon name="plus" />Create credential</button>}
        </header>
        {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss notification"><Icon name="close" /></button></div>}
        <div className={`capture-control-banner ${captureSettings?.paused ? 'capture-control-paused' : ''}`} role="status"><span>{captureSettingsLoading ? 'Checking capture controls…' : captureSettingsError ? 'Capture controls unavailable. New profile captures are disabled until refreshed.' : captureSettings?.paused ? 'New captures are paused for all clients and this profile. Existing memories remain available.' : 'New captures are enabled. Each client still needs your authorization and capture permission.'}</span>{page !== 'connections' && <button className="text-button" onClick={() => setPage('connections')}>Capture controls</button>}</div>
        {page === 'memories' && <>
          <div className="summary-strip"><div><span className="summary-number">{memories.length}</span><span>Memories shown</span></div><div><span className="summary-number">{activeClients.length}</span><span>Active credentials</span></div><button className="summary-review" aria-pressed={filters.status === 'candidate'} onClick={() => { closeMemory(); setFilters(current => ({ ...current, status: 'candidate' })); }}><Icon name="check" />Needs review</button></div>
          {filters.status === 'candidate' && <div className="review-intro"><div><h2>Your review makes the decision.</h2><p>Confirm a candidate with your own evidence, edit and confirm it, or dismiss it while keeping its history. Unconfirmed candidates stay outside fresh default recall.</p></div><button className="text-button" onClick={() => setFilters(current => ({ ...current, status: 'active' }))}>View active memories</button></div>}
          <section className="memory-panel" aria-label="Memories">
            <div className="filter-bar"><label className="search-field"><Icon name="search" /><span className="sr-only">Search memories</span><input type="search" value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })} placeholder="Search your memories…" /></label><label><span>Subject</span><input value={filters.subject} onChange={event => setFilters({ ...filters, subject: event.target.value })} placeholder="All subjects" /></label><label><span>Project</span><input value={filters.project_id} onChange={event => setFilters({ ...filters, project_id: event.target.value })} placeholder="All projects" /></label><label><span>Source</span><select aria-label="Source" value={filters.source} onChange={event => setFilters({ ...filters, source: event.target.value })}><option value="">All sources</option><option value="profile">Profile</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}{client.revoked_at ? ' (revoked)' : ''}</option>)}</select></label><label><span>Status</span><select aria-label="Status" value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            <div className="list-heading"><span>MEMORY</span><span>CLASSIFICATION</span><span>UPDATED</span><span /></div>
            {listLoading && <div className="list-progress" role="status">Searching…</div>}
            {!listLoading && memories.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="memories" /></span><h3>{filters.status === 'candidate' ? 'No candidates match this view.' : Object.entries(filters).some(([key, value]) => value && key !== 'status') || filters.status !== 'active' ? 'No matching memories.' : 'A fresh thread starts here.'}</h3><p>{filters.status === 'candidate' ? 'Reviewable proposals and model inferences appear here. Check your filters to see candidates in another scope.' : 'Save a direct statement here, or let a connected client capture context you approve.'}</p>{filters.status === 'candidate' ? <button className="button secondary" onClick={() => setFilters(current => ({ ...current, status: 'active' }))}>View active memories</button> : <button className="button secondary" onClick={openCapture} disabled={captureUnavailable}>Add your first memory</button>}</div>}
            <div className="memory-list">{memories.map(memory => <button key={memory.id} className={`memory-row ${selected?.memory.id === memory.id ? 'row-selected' : ''}`} onClick={() => openMemory(memory)}><div className="memory-statement"><div className="memory-meta"><span>{kindLabels[memory.kind] || memory.kind}</span><span className="meta-dot">·</span><span>{memory.project_id || 'Personal'}</span><span className="meta-dot">·</span><span>{memory.subject}</span></div><p>{memory.statement}</p></div><div className="classification"><span className={`badge origin-${memory.origin}`}>{originLabels[memory.origin] || memory.origin}</span>{memory.status !== 'active' && <span className={`badge status-${memory.status}`}>{statusLabels[memory.status] || memory.status}</span>}</div><div className="updated"><span>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(memory.updated_at || memory.created_at))}</span><small>Revision {memory.revision}</small></div><Icon name="arrow" /></button>)}</div>
          </section><p className="memory-footer">{memories.length === 100 ? "Showing the first 100 matches. Refine your filters to narrow the results. " : ""}Sources are preserved separately from interpretations. Inferences are always labeled.</p>
        </>}
        {page === 'captures' && <>
          {captureReceipt && <section className="capture-receipt" aria-label="Last save receipt"><h2>Last save receipt</h2><p>{captureReceipt.status === 'pending' ? 'Source stored; extraction was pending when this save was accepted.' : 'Your statement and source were saved when this request was accepted.'} Live status appears below.</p><div><span>{readableDate(captureReceipt.received_at)}</span><code>{captureReceipt.capture_id}</code></div></section>}
          <div className="capture-toolbar"><p role="status">{capturesLoading ? 'Refreshing current capture status…' : capturesError ? 'Live updates paused. Refresh to recover.' : captures.some(item => item.status === 'pending' || item.status === 'processing') ? 'Live updates every 4 seconds while processing is pending.' : 'Current status loaded.'}{capturesUpdatedAt && <span> Last updated {readableDate(capturesUpdatedAt)}.</span>}</p><button className="button secondary" disabled={capturesLoading} onClick={() => setCaptureRefreshVersion(value => value + 1)}>Refresh captures</button></div>
          {capturesError && <div className="notice error" role="alert"><span>{capturesError} {captures.length > 0 && 'The displayed records are from the last successful update.'}</span><button className="text-button" onClick={() => setCaptureRefreshVersion(value => value + 1)}>Try again</button></div>}
          <section className="capture-list" aria-label="Recent captures" aria-busy={capturesLoading}>
            {capturesLoading && captures.length === 0 && <div className="empty-state" role="status"><p>Loading captures…</p></div>}
            {!capturesLoading && !capturesError && captures.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="captures" /></span><h3>No captures yet.</h3><p>Save a direct memory or add source context for extraction. Captures from your connected clients appear here too.</p><button className="button secondary" onClick={openCapture} disabled={captureUnavailable}>Add your first context</button></div>}
            {captures.map(item => <article className="capture-card" key={item.capture_id} aria-labelledby={`capture-${item.capture_id}`} data-capture-id={item.capture_id}>
              <div className="capture-heading"><div><h2 id={`capture-${item.capture_id}`}>{clientName(item.client_id)}</h2><p>{item.project_id || 'Personal'} · {item.subject} · {readableDate(item.created_at)}</p></div><span className={`badge capture-status-${item.status}`}>{captureStatusLabels[item.status]}</span></div>
              <p className="capture-description">{captureStatusDescriptions[item.status]}</p>
              {item.job && <dl className="capture-properties"><div><dt>Extraction attempts</dt><dd>{item.job.attempts}</dd></div><div><dt>Started</dt><dd>{item.job.started_at ? readableDate(item.job.started_at) : 'Waiting'}</dd></div>{item.job.completed_at && <div><dt>Finished</dt><dd>{readableDate(item.job.completed_at)}</dd></div>}{item.status === 'complete' && item.job.accepted !== null && <div><dt>Extraction outcome</dt><dd>{item.job.accepted} accepted{item.job.skipped !== null ? ` · ${item.job.skipped} skipped` : ''}</dd></div>}</dl>}
              {item.status === 'failed' && <div className="capture-recovery"><p>{item.can_retry ? 'Retry extraction using the same source evidence. Current corrections and deletions remain authoritative.' : retryUnavailableMessages[item.retry_unavailable_reason || ''] || 'Retry is unavailable for the current capture state.'}</p>{item.can_retry && <button className="button secondary" disabled={retryingCapture !== null} onClick={() => retryCapture(item)}>{retryingCapture === item.capture_id ? 'Queuing retry…' : 'Retry extraction'}</button>}</div>}
              <details className="capture-evidence"><summary>Sources and current memories <span>{item.source_ids.length} sources · {item.memory_ids.length} memories</span></summary><div className="capture-links"><h3>Source evidence</h3>{item.source_ids.length === 0 ? <p>No source evidence remains.</p> : item.source_ids.map((id, index) => <button className="text-button" key={id} onClick={() => setSourceId(id)}>View source {index + 1}<code>{id}</code></button>)}<h3>Current memories</h3>{item.memory_ids.length === 0 ? <p>{item.status === 'pending' || item.status === 'processing' ? 'Memories will appear here if extraction admits them.' : 'No current memories are linked to this capture.'}</p> : item.memory_ids.map((id, index) => <button className="text-button" key={id} onClick={() => openMemory({ id })}>View memory {index + 1}<code>{id}</code></button>)}</div></details>
              <p className="capture-id">Capture ID: <code>{item.capture_id}</code></p>
            </article>)}
          </section>
          {nextCaptureOffset !== null && <div className="capture-pagination"><button className="button secondary" disabled={capturesLoading} onClick={() => setCapturePages(count => count + 1)}>Load older captures</button></div>}
          <p className="memory-footer">Status reflects current records. Forgotten sources and memories are removed from the evidence links.</p>
        </>}
        {page === 'connections' && <section className="connections-panel">
          <section className="connection-card capture-settings-card" aria-labelledby="capture-controls-title" aria-busy={captureSettingsLoading || captureSettingsBusy}><div className="connection-card-heading"><div><h2 id="capture-controls-title">Capture controls</h2><p>Pause new saves across every client and the profile.</p></div><span className={`badge ${captureSettings?.paused ? 'capture-status-pending' : 'status-active'}`}>{captureSettingsLoading ? 'Checking…' : captureSettingsError || !captureSettings ? 'Unavailable' : captureSettings.paused ? 'Paused' : 'Enabled'}</span></div>
            {captureSettingsError && <p className="field-error" role="alert">{captureSettingsError}</p>}
            <p className="fine-print">Existing memories and permitted recall stay available. Already saved sources, queued extraction and owner retries continue while capture is paused.</p><div className="actions"><button className="button primary" disabled={!captureSettings || captureSettingsLoading || captureSettingsBusy || !!captureSettingsError} onClick={toggleCapture}>{captureSettingsBusy ? 'Saving setting…' : captureSettings?.paused ? 'Resume new captures' : 'Pause new captures'}</button><button className="button secondary" disabled={captureSettingsLoading || captureSettingsBusy || connectionLoading} onClick={() => setSettingsRefreshVersion(value => value + 1)}>Refresh controls</button></div>
          </section>
          <section className="connection-card" aria-labelledby="mcp-connection-title" aria-busy={connectionLoading}><h2 id="mcp-connection-title">Connect an existing client</h2><p>Use this deployment’s configured endpoint and a separate Bearer credential for each client.</p>
            {connectionLoading && <p className="muted" role="status">Loading the configured MCP endpoint…</p>}
            {connectionError && <div><p className="field-error" role="alert">{connectionError}</p><button className="button secondary" disabled={connectionLoading || captureSettingsBusy} onClick={() => setSettingsRefreshVersion(value => value + 1)}>Retry endpoint</button></div>}
            {mcpEndpoint && !connectionError && <><CopyValue label="MCP endpoint" value={mcpEndpoint} rows={2} /><details className="connection-example"><summary>Generic remote MCP configuration</summary><CopyValue label="Connection example" value={JSON.stringify({ url: mcpEndpoint, headers: { Authorization: 'Bearer YOUR_CLIENT_TOKEN' } }, null, 2)} rows={6} /><p className="fine-print">Replace YOUR_CLIENT_TOKEN with your credential. Your host’s configuration wrapper and remote MCP support may vary; it must support Streamable HTTP and the Authorization header.</p></details></>}
            <p className="fine-print">Creating a credential or installing MCP does not grant transcript access or save conversations automatically. The client must explicitly invoke the tools with context you authorize. <a href="/openapi.json" target="_blank" rel="noreferrer">HTTP API schema</a></p>
          </section>
          <div className="credential-list-heading"><h2>Your client credentials</h2><button className="text-button" disabled={clientsLoading} onClick={refresh}>Refresh credentials</button></div>
          {clientsLoading && <p className="muted" role="status">Loading client credentials…</p>}
          {clientsError && <div className="notice error" role="alert"><span>{clientsError} {clients.length > 0 && 'The displayed credentials are from the last successful update.'}</span><button className="text-button" onClick={refresh}>Try again</button></div>}
          {!clientsLoading && !clientsError && clients.length === 0 && <div className="empty-state"><h3>No client credentials yet.</h3><p>Create a separate credential for each chatbot or coding agent.</p><button className="button secondary" onClick={openClient}>Create credential</button></div>}
          <div className="client-grid" aria-busy={clientsLoading}>{clients.map(client => <article key={client.id} className={`client-card ${client.revoked_at ? 'client-revoked' : ''}`}><div className="client-heading"><span className="client-icon"><Icon name="connections" /></span><span className={`badge ${client.revoked_at ? '' : 'status-active'}`}>{client.revoked_at ? 'Revoked' : 'Active credential'}</span></div><h3>{client.name}</h3><div className="client-permissions">{(client.permissions || []).map(permission => <span className="badge" key={permission}>{permission === 'capture' ? 'Capture context' : permission === 'read' ? 'Recall context' : permission}</span>)}</div><p className="scope-label">Project scope</p><p>{client.projects === null ? 'All projects and global / personal context' : client.projects?.length ? `${client.projects.join(', ')} + global / personal context` : 'Global / personal context only'}</p><dl className="client-dates"><div><dt>Created</dt><dd>{readableDate(client.created_at)}</dd></div><div><dt>Last authenticated request</dt><dd>{client.last_used_at ? readableDate(client.last_used_at) : 'Never used'}</dd></div></dl><code className="client-id">{client.id}</code>
            {!client.revoked_at && (pendingRevocation === client.id ? <div className="revoke-confirm"><p>Revoke this credential? Future requests lose access; existing memories remain.</p><button className="button danger" disabled={busy} onClick={() => revokeClient(client.id)}>Revoke access</button><button className="text-button" onClick={() => setPendingRevocation(null)}>Cancel</button></div> : <button className="text-button danger-text" onClick={() => setPendingRevocation(client.id)}>Revoke access</button>)}</article>)}</div>
          <p className="credential-observation fine-print">Creation records a credential, and last use records an authenticated request. Neither proves a host is installed or that capture has occurred. Open Captures to inspect saved sources.</p>
          <details className="client-instructions walkthrough"><summary>Try your first authorized capture and recall</summary><ol><li><h3>Choose permissions and connect.</h3><p>Create Client A with recall and capture access. Connect it using the endpoint above. For an independent recall, give Client B a separate recall credential. This example uses global / personal scope (<code>project_id: null</code>), which is included in restricted project scopes too.</p></li><li><h3>Authorize one synthetic save.</h3><p>Tell Client A: “For this synthetic test, remember: use short paragraphs in my writing.” This walkthrough only copies arguments; your client sends the request after you authorize it.</p><label className="check-label"><input type="checkbox" checked={walkthroughAuthorized} onChange={event => setWalkthroughAuthorized(event.target.checked)} /><span>I authorize saving this synthetic preference.</span></label><p className="fine-print">Call <code>context_capture</code> with these arguments. Keep the same idempotency key and event ID for an unchanged retry; use new IDs for a different source.</p><CopyValue label="Capture arguments" value={walkthroughCapture} rows={10} disabled={!walkthroughAuthorized || captureUnavailable} />{captureSettings?.paused && <p className="fine-print">Resume new captures above before trying this save.</p>}</li><li><h3>Recall from an independent client.</h3><p>After the direct save completes, ask Client B to call <code>context_search</code> with these arguments. A recall credential can read this authorized scope while new captures are paused.</p><CopyValue label="Recall arguments" value={walkthroughRecall} rows={6} /><p className="fine-print">HTTP alternatives use <code>POST /api/capture</code> with the capture JSON and <code>GET /api/context/search?query=short%20paragraphs</code>, both with <code>Authorization: Bearer TOKEN</code>. The GET searches permitted scopes, including projects; use MCP’s <code>project_id: null</code> for a global-only search.</p></li><li><h3>Check saved evidence and control access.</h3><p>Open Captures to inspect the source and current memory. Omitting <code>explicit_memories</code> saves source evidence for extraction: <code>pending</code> is a queued save, not a completed memory. Follow live status with <code>context_capture_status</code> using the returned capture ID. A source-only <code>saved</code> state has no extraction job; completed extraction can admit zero memories.</p><p>Pause new captures and verify a new save is rejected while recall still works. Resume to allow authorized captures again. Revoking a credential rejects its future requests and retains already saved context. Previously delivered client copies remain outside Threadkeeper’s control.</p></li></ol></details>
          <div className="client-instructions"><span className="eyebrow">CLIENT INSTRUCTIONS</span><h3>Give your client a clear memory contract.</h3><ul><li>Recall prior context when it could change an answer, decision, or action. Skip recall when that context is already visible.</li><li>Capture explicit requests to remember, durable user statements, confirmed decisions, and corrections, following the user’s capture policy.</li><li>Send minimal relevant evidence with roles and source boundaries. Label summaries as client-reported. Silence does not confirm an assistant proposal.</li><li>Fresh retrieval respects corrections, deletion, project scopes, capture permissions and revoked access.</li></ul></div>
        </section>}
        {page === 'portability' && <><div className="portability-grid"><section className="portability-card"><span className="small-icon"><Icon name="portability" /></span><h2>Export your memory</h2><p>A versioned JSON bundle preserves sources, memories, evidence, scope labels, and correction history. Credentials are excluded.</p><button className="button primary" onClick={downloadExport} disabled={exportBusy}>{exportBusy ? 'Preparing export…' : 'Download JSON export'}</button><p className="muted fine-print">An export is a copy of your personal context. Future deletions cannot remove copies you already downloaded.</p></section><section className="portability-card"><span className="small-icon"><Icon name="memories" /></span><h2>Import an export</h2><p>Restore a Threadkeeper bundle here. Imported client grants are not enabled, and validation checks source references and versions.</p><label className="file-picker"><input type="file" accept=".json,application/json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { setImportText(await file.text()); setImportName(file.name); } catch (error) { informError(error); } }} /><span>{importName || 'Choose a JSON export'}</span></label><button className="button secondary" disabled={!importText || importBusy} onClick={importBundle}>{importBusy ? 'Validating import…' : 'Validate & import'}</button></section></div><div className="info-card"><Icon name="lock" /><div><h3>Your deployment, your controls.</h3><p>Your operator controls authentication, inference endpoints, data storage, and resource limits. Managed hosting will share the same application features as self-hosting.</p></div></div></>}
      </div>
    </main>
    {(selected || detailLoading || detailError) && <div className="detail-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) closeMemory(); }}><aside className="detail-panel" role="dialog" aria-modal="true" aria-label="Memory details" ref={memoryPanel}><div className="detail-top"><span className="eyebrow">MEMORY DETAILS</span><button className="icon-button" onClick={closeMemory} aria-label="Close memory details"><Icon name="close" /></button></div>
      {detailLoading && <p className="muted" role="status">Loading evidence…</p>}{detailError && <div><p className="field-error" role="alert">{detailError}</p>{selectedMemoryId && <button className="button secondary" onClick={() => openMemory({ id: selectedMemoryId })} disabled={busy}>Refresh memory</button>}</div>}
      {reviewError && <div className="review-error" role="alert"><p>{reviewError}</p>{!detailError && selectedMemoryId && <button className="text-button" disabled={busy} onClick={() => openMemory({ id: selectedMemoryId })}>Refresh memory</button>}</div>}
      {selected && <><div className="detail-badges"><span className={`badge origin-${selected.memory.origin}`}>{originLabels[selected.memory.origin]}</span><span className={`badge status-${selected.memory.status}`}>{statusLabels[selected.memory.status]}</span></div>
        {editing ? <form onSubmit={selected.memory.status === 'candidate' ? event => { event.preventDefault(); void reviewMemory('confirm', true); } : editMemory} className="edit-form"><h2>{selected.memory.status === 'candidate' ? 'Edit and confirm this candidate' : 'Correct this memory'}</h2><p className="muted">{selected.memory.status === 'candidate' ? 'Your edited statement becomes separate user-authored confirmation evidence. The original proposal or inference remains in its history.' : 'Your edit creates a direct user correction in the same scope.'}</p><label>Statement<textarea aria-label="Statement" rows={5} value={editText} onChange={event => setEditText(event.target.value)} required maxLength={4000} disabled={busy} /></label><label>Effective date <span className="optional">(optional)</span><input type="datetime-local" value={editDate} onChange={event => setEditDate(event.target.value)} disabled={busy} /></label><div className="actions"><button className="button primary" disabled={busy || !editText.trim()}>{busy ? 'Saving…' : selected.memory.status === 'candidate' ? 'Save and confirm' : 'Save correction'}</button><button className="button secondary" type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button></div></form> : <><h2 className="detail-statement">{selected.memory.statement}</h2>
          {selected.memory.status === 'candidate' && <section className="candidate-review" aria-label="Candidate review"><h3>Review this candidate</h3><p>Confirming records your acceptance as separate user-authored evidence. The original proposal or inference and its sources remain inspectable.</p><div className="actions"><button className="button primary" disabled={busy} onClick={() => reviewMemory('confirm')}>{reviewingAction === 'confirm' ? 'Confirming…' : 'Confirm'}</button><button className="button secondary" disabled={busy} onClick={() => { setEditText(selected.memory.statement); setEditDate(''); setEditing(true); setDeleting(false); setDismissing(false); setReviewError(null); }}>Edit and confirm</button><button className="text-button" disabled={busy} onClick={() => { setDismissing(true); setDeleting(false); }}>Dismiss</button></div></section>}
          {selected.memory.status === 'dismissed' && <div className="dismissed-note"><p>This candidate was dismissed. Its evidence and history are retained, and it is excluded from Needs review and fresh default recall.</p></div>}
          <div className="actions">{!['candidate', 'dismissed'].includes(selected.memory.status) && <button className="button secondary" disabled={busy} onClick={() => { setEditText(selected.memory.statement); setEditDate(''); setEditing(true); setDeleting(false); }}>Edit memory</button>}<button className="text-button danger-text" disabled={busy} onClick={() => { setDeleting(true); setDismissing(false); }}>Delete</button></div>
        </>}
        {dismissing && selected.memory.status === 'candidate' && <div className="dismiss-confirm"><h3>Dismiss this candidate?</h3><p>Remove it from Needs review and fresh default recall. Its source evidence and revision history remain available under Dismissed.</p><div className="actions"><button className="button secondary" disabled={busy} onClick={() => reviewMemory('dismiss')}>{reviewingAction === 'dismiss' ? 'Dismissing…' : 'Dismiss candidate'}</button><button className="text-button" disabled={busy} onClick={() => setDismissing(false)}>Keep for review</button></div></div>}
        {deleting && <div className="delete-confirm" role="alert"><h3>Forget this memory?</h3><p>Removes this memory and its source evidence from future Threadkeeper retrieval. Other memories derived from the same source events are also removed. Connected agents may retain copies they already received.</p><div className="actions"><button className="button danger" disabled={busy} onClick={deleteMemory}>{busy ? 'Deleting…' : 'Delete memory'}</button><button className="text-button" disabled={busy} onClick={() => setDeleting(false)}>Keep memory</button></div></div>}
        <dl className="detail-properties"><div><dt>Subject</dt><dd>{selected.memory.subject}</dd></div><div><dt>Project</dt><dd>{selected.memory.project_id || 'Personal'}</dd></div><div><dt>Kind</dt><dd>{kindLabels[selected.memory.kind] || selected.memory.kind}</dd></div><div><dt>Effective</dt><dd>{readableDate(selected.memory.effective_at)}</dd></div><div><dt>Recorded</dt><dd>{readableDate(selected.memory.created_at)}</dd></div><div><dt>Revision</dt><dd>{selected.memory.revision}{selected.memory.authoritative ? selected.memory.origin === 'user_confirmed' ? ' · User confirmation' : ' · User correction' : ''}</dd></div></dl>
        <section className="detail-section"><h3>Supporting evidence <span>{selected.sources.length}</span></h3>{selected.sources.map(source => { const quote = selected.evidence?.find(item => item.source_id === source.id)?.quote; return <article className="source-card" key={source.id}><div className="source-heading"><strong>{clientName(source.client_id)}</strong><span>{source.author_role}</span></div><blockquote>{quote || source.text}</blockquote><p>{originLabels[source.origin] || source.origin}</p><dl><div><dt>Captured via</dt><dd>{captureMethodLabels[source.capture_method || ""] || "Not supplied"}</dd></div><div><dt>Occurred</dt><dd>{readableDate(source.occurred_at)}</dd></div><div><dt>Captured</dt><dd>{readableDate(source.recorded_at)}</dd></div></dl><details><summary>Source identity & full text</summary><code>{source.id}</code><p className="source-fulltext">{source.text}</p></details></article>; })}{selected.sources.length === 0 && <p className="muted">No supporting source was returned.</p>}</section>
        <section className="detail-section"><h3>Revision history <span>{selected.revisions.length}</span></h3><ol className="revision-list">{[...selected.revisions].sort((a, b) => b.revision - a.revision).map(revision => <li key={revision.revision}><div><strong>Revision {revision.revision}</strong><span>{readableDate(revision.created_at)}</span></div><p>{revision.statement}</p><small>{originLabels[revision.origin] || revision.origin} · {statusLabels[revision.status] || revision.status}</small>{revision.extractor && <p className="revision-extractor">Extracted by <code>{revision.extractor}</code></p>}</li>)}</ol></section><p className="muted memory-id">Memory ID: {selected.memory.id}</p>
      </>}
    </aside></div>}
    {sourceId && <Modal title="Source evidence" description="The saved source is preserved independently from memory interpretations." onClose={() => { setSourceId(null); setSource(null); }}>
      {sourceLoading && <p className="muted" role="status">Loading source evidence…</p>}
      {sourceError && <div><p className="field-error" role="alert">{sourceError}</p><button className="button secondary" onClick={() => setSourceRefreshVersion(value => value + 1)}>Try again</button></div>}
      {source && <article className="source-card"><div className="source-heading"><strong>{clientName(source.client_id)}</strong><span>{source.author_role}</span></div><blockquote>{source.text}</blockquote><p>{originLabels[source.origin] || source.origin}</p><dl><div><dt>Captured via</dt><dd>{captureMethodLabels[source.capture_method || ''] || 'Not supplied'}</dd></div><div><dt>Subject</dt><dd>{source.subject}</dd></div><div><dt>Project</dt><dd>{source.project_id || 'Personal'}</dd></div><div><dt>Occurred</dt><dd>{readableDate(source.occurred_at)}</dd></div><div><dt>Captured</dt><dd>{readableDate(source.recorded_at)}</dd></div></dl><code>{source.id}</code></article>}
    </Modal>}
    {modal === 'capture' && <Modal title="Add context" description={captureMode === 'explicit' ? 'Record a direct statement with source evidence for connected clients to remember.' : 'Save source context for a configured worker to extract source-backed memories.'} onClose={() => setModal(null)}><form onSubmit={capture}>{captureUnavailable && <div className="notice error" role="alert"><span>{captureSettings?.paused ? 'New captures are paused.' : 'Capture controls must be available before saving.'}</span><button type="button" className="text-button" onClick={() => { setModal(null); setPage('connections'); }}>Open capture controls</button></div>}<label>Save as<select name="capture_mode" aria-label="Save as" value={captureMode} disabled={busy} onChange={event => setCaptureMode(event.target.value as 'explicit' | 'extract')}><option value="explicit">Direct memory</option><option value="extract">Source for extraction</option></select></label><label>{captureMode === 'explicit' ? 'What should be remembered?' : 'Source context'}<textarea name="statement" rows={4} required maxLength={4000} placeholder={captureMode === 'explicit' ? 'State the fact, preference, decision, or constraint in your own words.' : 'Paste the context you want saved as source evidence.'} /></label>{captureMode === 'extract' && <p className="muted fine-print">The source is saved immediately. Extraction waits for an available worker; model inferences remain labeled for review.</p>}<div className="form-row">{captureMode === 'explicit' && <label>Kind<select name="kind" aria-label="Kind">{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}<label>Subject<input name="subject" defaultValue="self" required /></label></div><label>Project <span className="optional">(optional)</span><input name="project" placeholder="Leave blank for personal scope" /></label><div className="actions"><button className="button primary" disabled={busy || captureUnavailable}>{busy ? 'Saving…' : captureMode === 'explicit' ? 'Save memory' : 'Save source'}</button><button type="button" className="button secondary" onClick={() => setModal(null)} disabled={busy}>Cancel</button></div></form></Modal>}
    {modal === 'client' && <Modal title="Create a client credential" description="Create a separate token for one chatbot or coding agent. You can revoke it at any time." onClose={() => setModal(null)}><form onSubmit={createClient}><label>Client name<input name="name" required maxLength={100} placeholder="e.g. Coding agent" /></label><label className="check-label"><input name="capture" type="checkbox" defaultChecked /><span>Allow capture of approved context</span></label><p className="muted fine-print">Recall is enabled. Profile editing, full exports, and credential management remain owner-only. Capture permission follows your pause setting.</p><label>Scope<select name="scope" aria-label="Scope" value={clientScope} onChange={event => setClientScope(event.target.value as 'all' | 'selected')}><option value="all">All projects and global / personal context</option><option value="selected">Specific projects + global / personal context</option></select></label><label>Project IDs<input name="projects" disabled={clientScope === 'all'} placeholder="Comma-separated project IDs" /></label><p className="muted fine-print">Restricted credentials include the listed project IDs and global / personal context (project_id: null). Leave the IDs empty for global / personal context only.</p><div className="actions"><button className="button primary" disabled={busy}>{busy ? 'Creating…' : 'Create client token'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setModal(null)}>Cancel</button></div></form></Modal>}
    {token && <Modal title={`Credential created for ${token.name}`} description="Copy this credential now. It is shown only once. Keep it private and configure it in your client as a Bearer token." onClose={() => setToken(null)}><CopyValue label="Client token" value={token.value} rows={3} copyLabel="Copy token" />
      {connectionLoading && <p className="muted" role="status">Loading the configured MCP endpoint…</p>}
      {connectionError && <div><p className="field-error" role="alert">{connectionError} Keep a secure copy of the token while retrying.</p><button className="button secondary" disabled={connectionLoading || captureSettingsBusy} onClick={() => setSettingsRefreshVersion(value => value + 1)}>Retry endpoint</button></div>}
      {mcpEndpoint && !connectionError && <CopyValue label="MCP connection JSON" value={JSON.stringify({ url: mcpEndpoint, headers: { Authorization: `Bearer ${token.value}` } }, null, 2)} rows={7} copyLabel="Copy connection JSON" />}
      <p className="muted fine-print">This is a generic remote MCP connection object. The wrapper varies by host; check its Streamable HTTP and Authorization header support. Creating this credential does not install a host or grant access to conversations.</p><div className="actions"><button className="button primary" onClick={() => setToken(null)}>Done</button></div></Modal>}
  </div>;
}
