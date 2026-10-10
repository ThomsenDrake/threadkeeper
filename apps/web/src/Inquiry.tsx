import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CommandButton, Enclosure } from './InstrumentRoom';
import { originDescriptions, originLabels, recallWording } from './origins';

type RecalledMemory = {
  id: string;
  statement: string;
  origin: string;
  subject: string;
  project_id: string | null;
  revision: number;
  evidence: { source_id: string; quote: string; origin: string; author_role: string }[];
};
type RecallResponse = {
  memories: RecalledMemory[];
  snapshot_version: number;
  coverage?: { result_limit: number; retrieval: string; insufficient_context: boolean };
};
type Question = { query: string; project: string; subject: string };
type Recall = { question: Question; response: RecallResponse; refreshVersion: number };

export type InquiryProps = {
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  onOpenMemory: (id: string) => void;
  onError: (error: unknown) => void;
  refreshVersion: number;
  initialQuery?: string;
};

function Origin({ value }: { value: string }) {
  return <span className={`origin origin-${value}`} title={originDescriptions[value]}><span className="origin-mark" aria-hidden="true" />{originLabels[value] || value}</span>;
}

function scopeLabel(question: Question) {
  return `${question.project || 'All projects and personal context'} · ${question.subject || 'All subjects'}`;
}

export default function Inquiry({ request, onOpenMemory, onError, refreshVersion, initialQuery = '' }: InquiryProps) {
  const [query, setQuery] = useState(initialQuery);
  const [project, setProject] = useState('');
  const [subject, setSubject] = useState('');
  const [history, setHistory] = useState<Question[]>([]);
  const [recall, setRecall] = useState<Recall | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<Question | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const versionRef = useRef(refreshVersion);
  const requestRef = useRef(request);
  const onErrorRef = useRef(onError);
  versionRef.current = refreshVersion;
  requestRef.current = request;
  onErrorRef.current = onError;

  // Invalidate requests on both navigation and local Record changes. Rendering
  // also checks the version so an old statement cannot flash before this effect.
  useEffect(() => {
    controllerRef.current?.abort();
    requestSequence.current += 1;
    if (recall) setNotice('Your Record changed. Ask again to retrieve the current wording and sources.');
    setRecall(null);
    setPendingQuestion(null);
    setError('');
    return () => {
      controllerRef.current?.abort();
      requestSequence.current += 1;
    };
  }, [refreshVersion]);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    if (initialQuery.trim()) {
      setQuery(initialQuery);
      setProject('');
      setSubject('');
      void search({ query: initialQuery.trim(), project: '', subject: '' });
    }
  }, [initialQuery]);

  async function search(question: Question) {
    if (!question.query) { inputRef.current?.focus(); return; }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++requestSequence.current;
    const version = versionRef.current;
    setRecall(null);
    setPendingQuestion(question);
    setError('');
    setNotice('');
    const params = new URLSearchParams({ query: question.query, limit: '20' });
    if (question.project) params.set('project_id', question.project);
    if (question.subject) params.set('subject', question.subject);
    try {
      const response = await requestRef.current<RecallResponse>(`/context/search?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || sequence !== requestSequence.current || version !== versionRef.current) return;
      if (!Array.isArray(response.memories)) throw new Error('The Record returned an unreadable response. Please try again.');
      setRecall({ question, response, refreshVersion: version });
      // History retains search terms and scope, never copies of old memories.
      setHistory(previous => [question, ...previous.filter(item => item.query !== question.query || item.project !== question.project || item.subject !== question.subject)].slice(0, 8));
    } catch (cause) {
      if (controller.signal.aborted || sequence !== requestSequence.current || version !== versionRef.current) return;
      setError(cause instanceof Error ? cause.message : 'Your Record could not be searched. Please try again.');
      onErrorRef.current(cause);
    } finally {
      if (sequence === requestSequence.current && version === versionRef.current) setPendingQuestion(null);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void search({ query: query.trim(), project: project.trim(), subject: subject.trim() });
  }

  function repeat(question: Question) {
    setQuery(question.query);
    setProject(question.project);
    setSubject(question.subject);
    void search(question);
  }

  const current = recall?.refreshVersion === refreshVersion ? recall : null;
  const memories = current?.response.memories || [];
  const searching = pendingQuestion !== null;
  const activeQuestion = current?.question || pendingQuestion;

  return <>
    <aside className="wing wing-left" aria-label="Inquiry guide">
      <Enclosure className="enclosure-wing">
        <div className="wing-plate">
          <h2 className="plate-title">How Inquiry works</h2>
          <p className="plate-note">Search your saved Record with the same recall your agents use. Every result keeps its saved wording and origin label.</p>
          <p className="plate-note">Open a citation to inspect its source evidence, make a correction, or see its history.</p>
        </div>
        <div className="wing-plate">
          <h2 className="plate-title plate-title-minor">Try a starting point</h2>
          <ul className="suggestions">{['writing', 'deadline', 'project'].map(term => <li key={term}><button type="button" className="suggestion" onClick={() => repeat({ query: term, project: project.trim(), subject: subject.trim() })}>{term}</button></li>)}</ul>
          <p className="plate-note">A distinctive word from a memory can help narrow your search.</p>
        </div>
        {history.length > 0 && <div className="wing-plate inquiry-history">
          <h2 className="plate-title plate-title-minor">Recent inquiries</h2>
          <ul className="suggestions">{history.map(question => <li key={JSON.stringify(question)}><button type="button" className="suggestion" onClick={() => repeat(question)}>{question.query}<span className="inquiry-history-scope">{scopeLabel(question)}</span></button></li>)}</ul>
          <p className="plate-note">Choose an inquiry to search the current Record again.</p>
        </div>}
      </Enclosure>
    </aside>

    <div className="chamber-housing">
      <Enclosure className="enclosure-chamber">
        <div className="chamber" id="chamber" tabIndex={-1}>
          <section className="stratum stratum-inquiry" aria-labelledby="inquiry-title">
            <header className="stratum-head"><p className="kicker">Inquiry</p><h2 id="inquiry-title" className="chamber-title">Ask about your context</h2></header>
            <form className="inquiry-form" onSubmit={submit}>
              <div className="speaking-grille"><label className="sr-only" htmlFor="inquiry-input">Your question</label><textarea id="inquiry-input" ref={inputRef} rows={4} required maxLength={4000} value={query} onChange={event => setQuery(event.target.value)} placeholder="Ask about a date, preference or constraint…" onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }} /></div>
              <CommandButton type="submit" label={searching ? 'Searching' : 'Ask'} state={searching ? 'Searching your Record' : 'Searches your Record'} pending={searching} disabled={!query.trim()} />
              <details className="inquiry-scope">
                <summary>Narrow the scope</summary>
                <label>Project ID<input maxLength={200} value={project} onChange={event => setProject(event.target.value)} placeholder="All projects and personal context" /></label>
                <label>Subject<input maxLength={200} value={subject} onChange={event => setSubject(event.target.value)} placeholder="All subjects" /></label>
                <p className="plate-note">Leave a field blank to include all of that scope. Use “self” for your own subject.</p>
              </details>
            </form>
            <p className="inquiry-note">Current matching memories, with their origin labels. Your statements, corrections, agent reports, inferences and unaccepted suggestions stay distinct.</p>
            <div role="status" className="inquiry-note">{searching ? 'Searching your Record…' : notice || (current ? `${memories.length} matching current ${memories.length === 1 ? 'memory' : 'memories'}.` : '')}</div>
            {error && <p className="field-error" role="alert">{error}</p>}
            {activeQuestion && <ol className="transcript"><li className="exchange">
              <p className="asked"><span className="who">You asked</span>{activeQuestion.query}</p>
              <p className="inquiry-note">{scopeLabel(activeQuestion)}</p>
              {current && <Enclosure className="enclosure-answer">
                <p className="answer-tag">{memories.length ? `From ${memories.length} current ${memories.length === 1 ? 'memory' : 'memories'}` : 'No matching memories'}</p>
                <div className="answer-body">
                  {memories.length ? <><p>Here is what your Record says:</p><ol className="answer-points">{memories.map((memory, index) => <li key={memory.id}>
                    <Origin value={memory.origin} />
                    <p className="recalled-statement">{recallWording(memory)} <button type="button" className="cite" onClick={() => onOpenMemory(memory.id)} aria-label={`Cited memory ${index + 1}: open in the Record`}>{index + 1}</button></p>
                  </li>)}</ol></> : <p>No matching current memories were found for this query and scope. Try a distinctive word or broaden the scope.</p>}
                </div>
                {memories.length >= (current.response.coverage?.result_limit || 20) && <p className="plate-note">Showing up to {current.response.coverage?.result_limit || 20} matches. Refine your question or scope for more specific context.</p>}
              </Enclosure>}
            </li></ol>}
          </section>
        </div>
      </Enclosure>
    </div>

    <aside className="wing wing-right" aria-label="Cited context">
      <Enclosure className="enclosure-wing">
        <div className="wing-plate">
          <h2 className="plate-title">Cited context</h2>
          {memories.length ? <ol className="citations">{memories.map((memory, index) => <li key={memory.id}>
            <button type="button" className="citation-link" onClick={() => onOpenMemory(memory.id)}>
              <span className="cite-n">{index + 1}</span><span className="cite-text">{memory.statement}</span><Origin value={memory.origin} />
              <span className="cite-go">Open in the Record</span>
              <span className="inquiry-source-count">Revision {memory.revision} · {new Set(memory.evidence.map(evidence => evidence.source_id)).size} source{new Set(memory.evidence.map(evidence => evidence.source_id)).size === 1 ? '' : 's'}</span>
            </button>
          </li>)}</ol> : <p className="plate-note">{searching ? 'Retrieving current memories and their citations…' : current ? 'No context was cited for this inquiry.' : 'Matching memories will appear here, linked to their place in the Record.'}</p>}
        </div>
      </Enclosure>
    </aside>
  </>;
}
