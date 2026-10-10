import type { Detail, Memory, Overview } from './types';
import { Enclosure, Seal } from './InstrumentRoom';
import { originDescriptions, originLabels, sourceOriginLabel } from './origins';

const timestamp = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));

export function RecordOverview({ overview, error, memories, onSubject, onMemory, onBrowse }: {
  overview: Overview | null; error: string | null; memories: Memory[];
  onSubject: (subject: string) => void; onMemory: (id: string) => void; onBrowse: () => void;
}) {
  const subjects = [...(overview?.subjects || [])].filter(item => item.active_count > 0).sort((a, b) => b.active_count - a.active_count || a.subject.localeCompare(b.subject));
  const principal = subjects[0];
  const preview = (subject: string, className: string) => {
    const memory = memories.find(memory => memory.subject === subject);
    return memory && <><span className={className}>{memory.statement}</span><span className={`badge origin-${memory.origin}`} title={originDescriptions[memory.origin]}>{originLabels[memory.origin] || memory.origin}</span></>;
  };
  return <section className="record-overview" aria-label="Record overview">
    {overview ? <p className="precis">Your Record holds <em>{overview.active_count} current {overview.active_count === 1 ? 'memory' : 'memories'}</em> across <em>{subjects.length} {subjects.length === 1 ? 'subject' : 'subjects'}</em>, with {overview.source_count} preserved source {overview.source_count === 1 ? 'event' : 'events'}. Each memory says how it arrived. Every current memory is available to your agents within their permitted scopes.</p> : <p className="plate-note" role="status">{error ? 'The overview is unavailable. Choose Browse all memories to search your Record.' : 'Opening the subject index…'}</p>}
    {principal && <section className="principal"><button className="principal-plate" onClick={() => onSubject(principal.subject)}><span className="kicker">Subject · most held</span><span className="principal-name">{principal.subject}</span>{preview(principal.subject, 'principal-gist')}<span className="thread-index">{principal.active_count} current {principal.active_count === 1 ? 'memory' : 'memories'}</span><span className="open-cue">Open subject</span></button></section>}
    <div className="subject-secondary">{subjects.slice(1, 3).map(item => <button className="secondary-plate" key={item.subject} onClick={() => onSubject(item.subject)}><span className="kicker">Subject · {item.active_count} current {item.active_count === 1 ? 'memory' : 'memories'}</span><span className="secondary-name">{item.subject}</span>{preview(item.subject, 'secondary-gist')}<span className="open-cue">Open subject</span></button>)}</div>
    {subjects.length > 3 && <ul className="tertiary">{subjects.slice(3).map(item => <li key={item.subject}><button onClick={() => onSubject(item.subject)}><span className="tertiary-name">{item.subject}</span><span className="tally">{item.active_count} current</span></button></li>)}</ul>}
    {memories.length > 0 && <section className="lately"><h2 className="minor-title">Recently changed in this view</h2><ol>{[...memories].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3).map(memory => <li key={memory.id}><button onClick={() => onMemory(memory.id)}><span className="lately-date">{date(memory.updated_at)}</span><span className="lately-text">{memory.statement}</span><span className="lately-origin"><span className={`badge origin-${memory.origin}`} title={originDescriptions[memory.origin]}>{originLabels[memory.origin] || memory.origin}</span></span><span className="lately-topic">{memory.subject}</span></button></li>)}</ol></section>}
    {overview && overview.active_count === 0 && <div className="empty-state"><h2>A fresh thread starts here.</h2><p>Add a memory in your own words, or connect an agent to capture your context. New memories become available automatically with their origin labels.</p></div>}
    <button className="quiet-button" onClick={onBrowse}>Browse all memories <span aria-hidden="true">→</span></button>
  </section>;
}

export function Provenance({ detail, clientName }: { detail: Detail; clientName: (id: string | null) => string }) {
  return <section className="detail-section stratum-provenance" aria-labelledby="provenance-title"><header className="stratum-head"><p className="kicker">Sources and history</p><h3 id="provenance-title" className="minor-title">How this memory was formed</h3><p className="panel-note">Every source is preserved as captured. A correction updates the memory immediately and keeps the earlier wording in history.</p></header>
    <ol className="prov-rows">{[...detail.revisions].sort((a, b) => b.revision - a.revision).map(revision => {
      const current = revision.revision === detail.memory.revision;
      const evidence = detail.evidence?.filter(item => item.revision === revision.revision) || [];
      return <li className={`prov-row ${current ? 'is-current' : 'is-superseded'}`} key={revision.revision}>
        <div className="prov-cell prov-source"><Enclosure className="enclosure-evidence"><p className="prov-label">Source evidence</p>{evidence.length === 0 && <p className="plate-note">No source link returned for this revision.</p>}{evidence.map(item => {
          const source = detail.sources.find(source => source.id === item.source_id);
          return <div className="prov-source-body" key={item.source_id}><p className="prov-meta">{source ? `${source.author_role} · ${clientName(source.client_id)} · ${(source.capture_method || 'capture').replaceAll('_', ' ')} · ${sourceOriginLabel(source)}` : 'Source unavailable'}</p><blockquote className="prov-quote">{item.quote}</blockquote>{source && <><p className="prov-stamp"><span className="preserved">Preserved as captured</span><span>{timestamp(source.recorded_at)}</span></p><details><summary>Source identity & full text</summary><code>{source.id}</code><p className="source-fulltext">{source.text}</p>{source.occurred_at && <p className="plate-note">Occurred {timestamp(source.occurred_at)}</p>}</details></>}</div>;
        })}</Enclosure></div>
        <div className="prov-cell prov-junction"><span className="junction-seal"><Seal size={46} centre={revision.origin === 'user_confirmed' ? 'check' : 'monogram'} /></span><span className="junction-label" title={originDescriptions[revision.origin]}>{originLabels[revision.origin] || revision.origin}</span>{revision.extractor && <span className="junction-detail">Extracted by {revision.extractor}</span>}</div>
        <div className="prov-cell prov-interp"><div className="interp-surface"><p className="prov-label">Revision {revision.revision} · {current ? 'current' : 'historical'}</p><p className="interp-text">{revision.statement}</p><p className="prov-stamp"><span>{revision.kind.replaceAll('_', ' ')} · {revision.status}</span><span>{timestamp(revision.created_at)}</span><span>{current && revision.status === 'active' ? 'Delivered to your agents' : 'Kept in history, no longer delivered'}</span></p></div></div>
      </li>;
    })}</ol>
  </section>;
}
