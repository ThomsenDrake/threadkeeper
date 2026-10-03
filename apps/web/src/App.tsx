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
type Revision = { revision: number; statement: string; origin: string; status: string; effective_at: string | null; created_at: string; editor_client_id: string | null };
type Detail = { memory: Memory; sources: Source[]; evidence?: Evidence[]; revisions: Revision[] };
type Client = { id: string; name: string; permissions: string[]; projects: string[] | null; created_at?: string; revoked_at?: string | null };
type Page = 'memories' | 'connections' | 'portability';
type Notice = { text: string; type: 'success' | 'error' };

const originLabels: Record<string, string> = {
  user_explicit: 'Direct user statement', user_confirmed: 'User confirmed', assistant_proposed: 'Assistant proposal',
  agent_reported: 'Client-reported context', inferred: 'Model inference',
};
const statusLabels: Record<string, string> = { active: 'Active', candidate: 'Needs review', disputed: 'Disputed', superseded: 'Superseded' };
const kindLabels: Record<string, string> = { fact: 'Fact', preference: 'Preference', decision: 'Decision', constraint: 'Constraint', project_state: 'Project state' };
const captureMethodLabels: Record<string, string> = { explicit_capture: 'Explicit capture', client_summary: 'Client summary', profile_entry: 'Profile entry', profile_correction: 'Profile correction', import: 'Import' };
const readableDate = (date?: string | null) => date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)) : 'Not supplied';
const errorMessages: Record<string, string> = {
  invalid_credentials: 'The email or password is incorrect.',
  rate_limit: 'Too many sign-in attempts. Please try again in a minute.',
  validation: 'Some details are invalid. Check your entries and try again.',
  unauthorized: 'Your session has ended. Sign in again to continue.',
  scope_denied: 'This client does not have access to the requested scope.',
  internal_error: 'The service could not complete this request. Please try again.',
};

class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof result.error === 'string' ? result.error : result.error?.message || result.message || `Request failed (${response.status})`;
    throw new ApiError(errorMessages[reason] || reason, response.status);
  }
  return result as T;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    memories: <><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h6" /></>,
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
  const [filters, setFilters] = useState({ query: '', subject: '', project_id: '', source: '', status: 'active' });
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editDate, setEditDate] = useState('');
  const [deleting, setDeleting] = useState(false);
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
  const captureRequest = useRef<{ fingerprint: string; key: string; sourceId: string; occurredAt: string } | null>(null);

  const informError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      setUser(null); setSelected(null); setMemories([]); setClients([]); setToken(null); setModal(null);
    }
    setNotice({ type: 'error', text: error instanceof Error ? error.message : 'The request could not be completed.' });
  };
  const refresh = () => setRefreshVersion(v => v + 1);

  useEffect(() => {
    api<{ user: { email: string } }>('/auth/me').then(result => setUser(result.user)).catch(error => {
      if (!(error instanceof ApiError) || error.status !== 401) informError(error);
    }).finally(() => setLoadingAuth(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    api<{ clients: Client[] }>('/clients').then(result => setClients(result.clients)).catch(informError);
  }, [user, refreshVersion]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setListLoading(true);
      const query = new URLSearchParams([...Object.entries(filters).filter(([,value]) => value), ['limit', '100']]);
      api<{ memories: Memory[] }>(`/memories?${query}`, { signal: controller.signal }).then(result => setMemories(result.memories)).catch(error => {
        if (error instanceof Error && error.name !== 'AbortError') informError(error);
      }).finally(() => { if (!controller.signal.aborted) setListLoading(false); });
    }, 150);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [user, filters, refreshVersion]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoginError(''); setLoginBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<{ user: { email: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      setUser(result.user); setNotice(null);
    } catch (error) { setLoginError(error instanceof Error ? error.message : 'Sign-in failed.'); }
    finally { setLoginBusy(false); }
  }

  async function openMemory(memory: Memory) {
    setSelected(null); setDetailLoading(true); setDetailError(null); setEditing(false); setDeleting(false);
    try { setSelected(await api<Detail>(`/memories/${encodeURIComponent(memory.id)}`)); }
    catch (error) { setDetailError(error instanceof Error ? error.message : 'Unable to load this memory.'); }
    finally { setDetailLoading(false); }
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
      setSelected(null); setDeleting(false); refresh();
      setNotice({ type: 'success', text: 'Deleted. This memory and affected evidence are removed from future retrieval.' });
    } catch (error) { informError(error); } finally { setBusy(false); }
  }

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true);
    const form = new FormData(event.currentTarget);
    const text = String(form.get('statement') || '').trim();
    const subject = String(form.get('subject') || '').trim() || 'self';
    const project = String(form.get('project') || '').trim() || null;
    const fingerprint = JSON.stringify([text, subject, project, form.get('kind')]);
    if (!captureRequest.current || captureRequest.current.fingerprint !== fingerprint) captureRequest.current = { fingerprint, key: crypto.randomUUID(), sourceId: crypto.randomUUID(), occurredAt: new Date().toISOString() };
    const { key, sourceId, occurredAt } = captureRequest.current;
    try {
      const result = await api<{ status: string }>('/capture', { method: 'POST', body: JSON.stringify({
        idempotency_key: key, project_id: project, subject,
        events: [{ id: sourceId, text, author_role: 'user', origin: 'user_explicit', capture_method: 'profile_entry', occurred_at: occurredAt }],
        explicit_memories: [{ statement: text, quote: text, source_event_id: sourceId, kind: form.get('kind'), origin: 'user_explicit', subject }],
      }) });
      setModal(null); captureRequest.current = null; refresh(); setNotice({ type: 'success', text: result.status === 'pending' ? 'Source saved. Memory processing is pending.' : 'Saved as your direct statement, with its source evidence.' });
    } catch (error) { informError(error); } finally { setBusy(false); }
  }

  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); const form = new FormData(event.currentTarget);
    try {
      const projects = String(form.get('projects') || '').split(',').map(item => item.trim()).filter(Boolean);
      const permissions = ['read', ...(form.get('capture') ? ['capture'] : [])];
      const result = await api<{ client: Client; token: string }>('/clients', { method: 'POST', body: JSON.stringify({ name: form.get('name'), permissions, projects: form.get('scope') === 'all' ? null : projects }) });
      setModal(null); setToken({ value: result.token, name: result.client.name }); refresh();
    } catch (error) { informError(error); } finally { setBusy(false); }
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
    <aside className="sidebar"><Brand /><div className="workspace-label">PERSONAL CONTEXT</div><nav aria-label="Main navigation">{(['memories', 'connections', 'portability'] as Page[]).map(item => <button key={item} className={`nav-item ${page === item ? 'selected' : ''}`} onClick={() => { setPage(item); setSelected(null); }}><Icon name={item} />{item === 'memories' ? 'Your memories' : item === 'connections' ? 'Connections' : 'Import & export'}{item === 'memories' && <span className="nav-count">{memories.length}</span>}</button>)}</nav>
      <div className="sidebar-note"><span className="status-dot" />You own the memory.<p>Connected clients request context. You decide what stays.</p></div>
      <div className="account"><div className="avatar">{user.email[0].toUpperCase()}</div><div><span className="account-label">Local account</span><span className="account-email" title={user.email}>{user.email}</span></div><button className="signout" onClick={async () => { try { await api('/auth/logout', { method: 'POST' }); setUser(null); setSelected(null); setMemories([]); setClients([]); setToken(null); } catch (error) { informError(error); } }}>Sign out</button></div>
    </aside>
    <main className="main-content">
      <div className="topbar"><span>Profile <span className="breadcrumb-slash">/</span> {page === 'memories' ? 'Your memories' : page === 'connections' ? 'Connections' : 'Portability'}</span><span className="topbar-detail"><Icon name="lock" />Private to your account</span></div>
      <div className="page-content">
        <header className="page-header"><div><span className="eyebrow">{page === 'memories' ? 'THE THREAD YOU KEEP' : page === 'connections' ? 'CONTEXT, WITH PERMISSION' : 'TAKE YOUR CONTEXT WITH YOU'}</span><h1>{page === 'memories' ? 'Your memory, on your terms.' : page === 'connections' ? 'Connected clients.' : 'Memory without lock-in.'}</h1><p>{page === 'memories' ? 'Review what is remembered, where it came from, and what needs to change.' : page === 'connections' ? 'Give each chatbot or coding agent only the access it needs.' : 'Export your sources and memories, or bring them into this deployment.'}</p></div>
          {page === 'memories' && <button className="button primary" onClick={() => setModal('capture')}><Icon name="plus" />Add memory</button>}{page === 'connections' && <button className="button primary" onClick={() => setModal('client')}><Icon name="plus" />Connect a client</button>}
        </header>
        {notice && <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss notification"><Icon name="close" /></button></div>}
        {page === 'memories' && <>
          <div className="summary-strip"><div><span className="summary-number">{memories.length}</span><span>Memories shown</span></div><div><span className="summary-number">{activeClients.length}</span><span>Connected clients</span></div><div className="summary-note"><Icon name="check" /><span>Profile edits become authoritative corrections.</span></div></div>
          <section className="memory-panel" aria-label="Memories">
            <div className="filter-bar"><label className="search-field"><Icon name="search" /><span className="sr-only">Search memories</span><input type="search" value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })} placeholder="Search your memories…" /></label><label><span>Subject</span><input value={filters.subject} onChange={event => setFilters({ ...filters, subject: event.target.value })} placeholder="All subjects" /></label><label><span>Project</span><input value={filters.project_id} onChange={event => setFilters({ ...filters, project_id: event.target.value })} placeholder="All projects" /></label><label><span>Source</span><select aria-label="Source" value={filters.source} onChange={event => setFilters({ ...filters, source: event.target.value })}><option value="">All sources</option><option value="profile">Profile</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name}{client.revoked_at ? ' (revoked)' : ''}</option>)}</select></label><label><span>Status</span><select aria-label="Status" value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            <div className="list-heading"><span>MEMORY</span><span>CLASSIFICATION</span><span>UPDATED</span><span /></div>
            {listLoading && <div className="list-progress" role="status">Searching…</div>}
            {!listLoading && memories.length === 0 && <div className="empty-state"><span className="empty-icon"><Icon name="memories" /></span><h3>{Object.entries(filters).some(([key, value]) => value && key !== 'status') || filters.status !== 'active' ? 'No matching memories.' : 'A fresh thread starts here.'}</h3><p>Save a direct statement here, or let a connected client capture context you approve.</p><button className="button secondary" onClick={() => setModal('capture')}>Add your first memory</button></div>}
            <div className="memory-list">{memories.map(memory => <button key={memory.id} className={`memory-row ${selected?.memory.id === memory.id ? 'row-selected' : ''}`} onClick={() => openMemory(memory)}><div className="memory-statement"><div className="memory-meta"><span>{kindLabels[memory.kind] || memory.kind}</span><span className="meta-dot">·</span><span>{memory.project_id || 'Personal'}</span><span className="meta-dot">·</span><span>{memory.subject}</span></div><p>{memory.statement}</p></div><div className="classification"><span className={`badge origin-${memory.origin}`}>{originLabels[memory.origin] || memory.origin}</span>{memory.status !== 'active' && <span className={`badge status-${memory.status}`}>{statusLabels[memory.status] || memory.status}</span>}</div><div className="updated"><span>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(memory.updated_at || memory.created_at))}</span><small>Revision {memory.revision}</small></div><Icon name="arrow" /></button>)}</div>
          </section><p className="memory-footer">{memories.length === 100 ? "Showing the first 100 matches. Refine your filters to narrow the results. " : ""}Sources are preserved separately from interpretations. Inferences are always labeled.</p>
        </>}
        {page === 'connections' && <section className="connections-panel"><div className="info-card"><Icon name="connections" /><div><h3>One memory layer. Independent clients.</h3><p>Clients call capture and recall through MCP. Connecting a client does not automatically capture every conversation. <a href="/openapi.json" target="_blank" rel="noreferrer">HTTP API schema</a></p></div></div>
          {activeClients.length === 0 && <div className="empty-state"><h3>No clients connected yet.</h3><p>Create separate credentials for each chatbot or coding agent.</p><button className="button secondary" onClick={() => setModal('client')}>Connect a client</button></div>}
          <div className="client-grid">{clients.map(client => <article key={client.id} className={`client-card ${client.revoked_at ? 'client-revoked' : ''}`}><div className="client-heading"><span className="client-icon"><Icon name="connections" /></span><span className={`badge ${client.revoked_at ? '' : 'status-active'}`}>{client.revoked_at ? 'Revoked' : 'Connected'}</span></div><h3>{client.name}</h3><div className="client-permissions">{(client.permissions || []).map(permission => <span className="badge" key={permission}>{permission === 'capture' ? 'Capture context' : permission === 'read' ? 'Recall context' : permission}</span>)}</div><p className="scope-label">Project scope</p><p>{client.projects === null ? 'All projects and personal context' : client.projects?.length ? client.projects.join(', ') : 'Personal context only'}</p><code className="client-id">{client.id}</code>
            {!client.revoked_at && (pendingRevocation === client.id ? <div className="revoke-confirm"><p>Stop this client’s access immediately?</p><button className="button danger" disabled={busy} onClick={() => revokeClient(client.id)}>Revoke access</button><button className="text-button" onClick={() => setPendingRevocation(null)}>Cancel</button></div> : <button className="text-button danger-text" onClick={() => setPendingRevocation(client.id)}>Revoke access</button>)}</article>)}</div>
          <div className="client-instructions"><span className="eyebrow">CLIENT INSTRUCTIONS</span><h3>Give your client a clear memory contract.</h3><ul><li>Recall prior context when it could change an answer, decision, or action. Skip recall when that context is already visible.</li><li>Capture explicit requests to remember, durable user statements, confirmed decisions, and corrections, following the user’s capture policy.</li><li>Send minimal relevant evidence with roles and source boundaries. Label summaries as client-reported.</li><li>Fresh retrieval respects corrections, deletion, and revoked permissions.</li></ul><p className="muted">MCP endpoint: <code>{window.location.origin}/mcp</code> · Use the client token as a Bearer credential.</p></div>
        </section>}
        {page === 'portability' && <><div className="portability-grid"><section className="portability-card"><span className="small-icon"><Icon name="portability" /></span><h2>Export your memory</h2><p>A versioned JSON bundle preserves sources, memories, evidence, scope labels, and correction history. Credentials are excluded.</p><button className="button primary" onClick={downloadExport} disabled={exportBusy}>{exportBusy ? 'Preparing export…' : 'Download JSON export'}</button><p className="muted fine-print">An export is a copy of your personal context. Future deletions cannot remove copies you already downloaded.</p></section><section className="portability-card"><span className="small-icon"><Icon name="memories" /></span><h2>Import an export</h2><p>Restore a Threadkeeper bundle here. Imported client grants are not enabled, and validation checks source references and versions.</p><label className="file-picker"><input type="file" accept=".json,application/json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { setImportText(await file.text()); setImportName(file.name); } catch (error) { informError(error); } }} /><span>{importName || 'Choose a JSON export'}</span></label><button className="button secondary" disabled={!importText || importBusy} onClick={importBundle}>{importBusy ? 'Validating import…' : 'Validate & import'}</button></section></div><div className="info-card"><Icon name="lock" /><div><h3>Your deployment, your controls.</h3><p>Your operator controls authentication, inference endpoints, data storage, and resource limits. Managed hosting will share the same application features as self-hosting.</p></div></div></>}
      </div>
    </main>
    {(selected || detailLoading || detailError) && <div className="detail-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) { setSelected(null); setDetailError(null); } }}><aside className="detail-panel" aria-label="Memory details"><div className="detail-top"><span className="eyebrow">MEMORY DETAILS</span><button className="icon-button" onClick={() => { setSelected(null); setDetailError(null); }} aria-label="Close memory details"><Icon name="close" /></button></div>
      {detailLoading && <p className="muted">Loading evidence…</p>}{detailError && <p className="field-error" role="alert">{detailError}</p>}
      {selected && <><div className="detail-badges"><span className={`badge origin-${selected.memory.origin}`}>{originLabels[selected.memory.origin]}</span><span className={`badge status-${selected.memory.status}`}>{statusLabels[selected.memory.status]}</span></div>
        {editing ? <form onSubmit={editMemory} className="edit-form"><h2>Correct this memory</h2><p className="muted">Your edit creates a direct user correction in the same scope.</p><label>Statement<textarea aria-label="Statement" rows={5} value={editText} onChange={event => setEditText(event.target.value)} required maxLength={4000} /></label><label>Effective date <span className="optional">(optional)</span><input type="datetime-local" value={editDate} onChange={event => setEditDate(event.target.value)} /></label><div className="actions"><button className="button primary" disabled={busy || !editText.trim()}>{busy ? 'Saving…' : 'Save correction'}</button><button className="button secondary" type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button></div></form> : <><h2 className="detail-statement">{selected.memory.statement}</h2><div className="actions"><button className="button secondary" onClick={() => { setEditText(selected.memory.statement); setEditDate(''); setEditing(true); setDeleting(false); }}>Edit memory</button><button className="text-button danger-text" onClick={() => setDeleting(true)}>Delete</button></div></>}
        {deleting && <div className="delete-confirm" role="alert"><h3>Forget this memory?</h3><p>Removes this memory and its source evidence from future Threadkeeper retrieval. Other memories derived from the same source events are also removed. Connected agents may retain copies they already received.</p><div className="actions"><button className="button danger" disabled={busy} onClick={deleteMemory}>{busy ? 'Deleting…' : 'Delete memory'}</button><button className="text-button" disabled={busy} onClick={() => setDeleting(false)}>Keep memory</button></div></div>}
        <dl className="detail-properties"><div><dt>Subject</dt><dd>{selected.memory.subject}</dd></div><div><dt>Project</dt><dd>{selected.memory.project_id || 'Personal'}</dd></div><div><dt>Kind</dt><dd>{kindLabels[selected.memory.kind] || selected.memory.kind}</dd></div><div><dt>Effective</dt><dd>{readableDate(selected.memory.effective_at)}</dd></div><div><dt>Recorded</dt><dd>{readableDate(selected.memory.created_at)}</dd></div><div><dt>Revision</dt><dd>{selected.memory.revision}{selected.memory.authoritative ? ' · User correction' : ''}</dd></div></dl>
        <section className="detail-section"><h3>Supporting evidence <span>{selected.sources.length}</span></h3>{selected.sources.map(source => { const quote = selected.evidence?.find(item => item.source_id === source.id)?.quote; return <article className="source-card" key={source.id}><div className="source-heading"><strong>{clientName(source.client_id)}</strong><span>{source.author_role}</span></div><blockquote>{quote || source.text}</blockquote><p>{originLabels[source.origin] || source.origin}</p><dl><div><dt>Captured via</dt><dd>{captureMethodLabels[source.capture_method || ""] || "Not supplied"}</dd></div><div><dt>Occurred</dt><dd>{readableDate(source.occurred_at)}</dd></div><div><dt>Captured</dt><dd>{readableDate(source.recorded_at)}</dd></div></dl><details><summary>Source identity & full text</summary><code>{source.id}</code><p className="source-fulltext">{source.text}</p></details></article>; })}{selected.sources.length === 0 && <p className="muted">No supporting source was returned.</p>}</section>
        <section className="detail-section"><h3>Revision history <span>{selected.revisions.length}</span></h3><ol className="revision-list">{[...selected.revisions].sort((a, b) => b.revision - a.revision).map(revision => <li key={revision.revision}><div><strong>Revision {revision.revision}</strong><span>{readableDate(revision.created_at)}</span></div><p>{revision.statement}</p><small>{originLabels[revision.origin] || revision.origin} · {statusLabels[revision.status] || revision.status}</small></li>)}</ol></section><p className="muted memory-id">Memory ID: {selected.memory.id}</p>
      </>}
    </aside></div>}
    {modal === 'capture' && <Modal title="Add a memory" description="Record something you want connected clients to remember. This is saved as your direct statement with source evidence." onClose={() => setModal(null)}><form onSubmit={capture}><label>What should be remembered?<textarea name="statement" rows={4} required maxLength={4000} placeholder="State the fact, preference, decision, or constraint in your own words." /></label><div className="form-row"><label>Kind<select name="kind" aria-label="Kind">{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Subject<input name="subject" defaultValue="self" required /></label></div><label>Project <span className="optional">(optional)</span><input name="project" placeholder="Leave blank for personal scope" /></label><div className="actions"><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save memory'}</button><button type="button" className="button secondary" onClick={() => setModal(null)} disabled={busy}>Cancel</button></div></form></Modal>}
    {modal === 'client' && <Modal title="Connect a client" description="Create a separate token for one chatbot or coding agent. You can revoke it at any time." onClose={() => setModal(null)}><form onSubmit={createClient}><label>Client name<input name="name" required maxLength={100} placeholder="e.g. Coding agent" /></label><label className="check-label"><input name="capture" type="checkbox" defaultChecked /><span>Allow capture of approved context</span></label><p className="muted fine-print">Recall is enabled. Profile editing, full exports, and grant management remain owner-only.</p><label>Scope<select name="scope" aria-label="Scope" defaultValue="all" onChange={event => { const input = event.currentTarget.form?.elements.namedItem('projects') as HTMLInputElement; if (input) input.disabled = event.target.value === 'all'; }}><option value="all">All projects and personal context</option><option value="selected">Specific projects and personal context</option></select></label><label>Project IDs<input name="projects" disabled placeholder="Comma-separated project IDs" /></label><div className="actions"><button className="button primary" disabled={busy}>{busy ? 'Creating…' : 'Create client token'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setModal(null)}>Cancel</button></div></form></Modal>}
    {token && <Modal title={`${token.name} is ready`} description="Copy this credential now. It is shown only once. Keep it private and configure it in your client as a Bearer token." onClose={() => setToken(null)}><label>Client token<textarea aria-label="Client token" readOnly rows={3} value={token.value} className="token-value" onFocus={event => event.currentTarget.select()} /></label><div className="actions"><button className="button primary" onClick={async () => { try { await navigator.clipboard.writeText(token.value); setNotice({ type: 'success', text: 'Client token copied.' }); } catch { setNotice({ type: 'error', text: 'Select the token and copy it manually.' }); } }}>Copy token</button><button className="button secondary" onClick={() => setToken(null)}>Done</button></div></Modal>}
  </div>;
}
