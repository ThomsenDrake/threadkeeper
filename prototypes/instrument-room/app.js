(function () {
  'use strict';

  const D = window.TK_DATA;
  const GL = window.TK_GLYPHS;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion.matches ? Math.min(ms, 60) : ms));

  /* ---------- synthetic store (page memory only) ---------- */

  const memories = D.memories.map((m) => ({ ...m, revisions: m.revisions.map((r) => ({ ...r })) }));
  const sources = { ...D.sources };
  const topics = D.topics;
  const topicById = (id) => topics.find((t) => t.id === id);
  const memById = (id) => memories.find((m) => m.id === id);
  const current = (m) => m.revisions[m.revisions.length - 1];
  const agentName = (id) => (id ? D.agents.find((a) => a.id === id).name : 'Threadkeeper profile');
  const topicMems = (tid) => memories.filter((m) => m.topic === tid);
  const threadMems = (thid) => memories.filter((m) => m.thread === thid);
  const sourceIdsOf = (m) => [...new Set(m.revisions.flatMap((r) => r.sources))];
  const liveSourceIds = () => new Set(memories.flatMap(sourceIdsOf));

  const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const words = (n) => (n < NUM.length ? NUM[n] : String(n));
  const count = (n, one, many) => `${words(n)} ${n === 1 ? one : many || one + 's'}`;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (s) => {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  };
  const nowStamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /* ---------- state ---------- */

  const S = {
    route: { view: 'record', topic: null, memory: null, sources: false },
    mode: null,
    openThreads: new Set(),
    notice: null,
    chat: [],
    focusChamber: false,
    focusInquiry: false,
    wingsView: null,
    conduit: null,
    rebuilt: new Set()
  };

  /* Summaries are derived content: once a change touches a subject, the prototype rebuilds them from current wording. */
  const RANK = ['user_confirmed', 'user_explicit', 'agent_reported', 'inferred', 'assistant_proposed'];
  function gist(t) {
    if (!S.rebuilt.has(t.id)) return t.gist;
    const ms = topicMems(t.id).sort((a, b) => RANK.indexOf(a.origin) - RANK.indexOf(b.origin)).slice(0, 2);
    const clip = (s) => (s.length > 140 ? `${s.slice(0, 137).replace(/\s+\S*$/, '')}…` : s);
    return ms.length ? ms.map((m) => clip(current(m).statement)).join(' ') : 'Nothing is held on this subject now.';
  }
  const gistNote = (t) => (S.rebuilt.has(t.id) ? '<span class="gist-note">Summary rebuilt from current memories after your change</span>' : '');

  /* ---------- shared construction ---------- */

  function enclosure(cls, inner, extra = '') {
    return `<div class="enclosure ${cls}">${extra}<div class="enc-electrum"><div class="enc-iron"><div class="enc-rail"><div class="enc-well">${inner}</div></div></div></div></div>`;
  }

  function originTag(origin) {
    const o = D.origins[origin];
    return `<span class="origin origin-${origin}"><span class="origin-mark" aria-hidden="true"></span>${esc(o.short)}</span>`;
  }

  function commandSeal({ id, label, state, tone = 'electrum', type = 'button', centre = 'monogram' }) {
    return `<button class="cmd" id="${id}" type="${type}" data-tone="${tone}" data-state="idle">
      <span class="cmd-housing">
        <span class="cmd-socket"><span class="cmd-disc">${GL.seal({ size: 52, centre, tone, text: 'THREADKEEPER \u00b7 COMMAND \u00b7 THREADKEEPER \u00b7 ' })}</span></span>
        <span class="cmd-text"><span class="cmd-label">${esc(label)}</span><span class="cmd-state" aria-live="polite">${esc(state)}</span></span>
        <span class="cmd-terminal" aria-hidden="true"><span></span></span>
      </span>
    </button>`;
  }

  async function runCommand(btn, { pending, done, tone, action }) {
    if (btn.dataset.state !== 'idle') return false;
    const disc = $('.cmd-disc', btn);
    const text = $('.cmd-state', btn);
    btn.dataset.state = 'pending';
    btn.setAttribute('aria-disabled', 'true');
    disc.innerHTML = GL.seal({ size: 52, centre: 'pending', tone });
    text.textContent = pending;
    await wait(520);
    const result = await action();
    if (result === false) {
      btn.dataset.state = 'idle';
      btn.removeAttribute('aria-disabled');
      disc.innerHTML = GL.seal({ size: 52, tone });
      return false;
    }
    btn.dataset.state = 'done';
    disc.innerHTML = GL.seal({ size: 52, centre: 'check', tone });
    text.textContent = typeof done === 'function' ? done(result) : done;
    announce(text.textContent);
    await wait(900);
    return result;
  }

  function announce(msg) {
    const a = $('#announcer');
    a.textContent = '';
    requestAnimationFrame(() => { a.textContent = msg; });
  }

  /* ---------- routing ---------- */

  function parse() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'inquiry') return { view: 'inquiry' };
    const topic = parts[1] && topicById(parts[1]) ? parts[1] : null;
    const m = topic && parts[2] ? memById(parts[2]) : null;
    const memory = m && m.topic === topic ? m.id : null;
    return { view: 'record', topic, memory, sources: !!memory && parts[3] === 'sources' };
  }

  function go(hash, { focus = false } = {}) {
    S.focusChamber = focus;
    if (location.hash === hash) onRoute();
    else location.hash = hash;
  }

  const hrefTopic = (tid) => `#/record/${tid}`;
  const hrefMem = (m) => `#/record/${m.topic}/${m.id}`;

  function onRoute() {
    const prev = S.route;
    const r = parse();
    S.route = r;
    if (r.memory !== prev.memory) S.mode = null;
    if (r.view === 'record' && r.memory) S.openThreads.add(memById(r.memory).thread);
    else if (r.view === 'record' && r.topic && r.topic !== prev.topic) {
      const first = topicById(r.topic).threads.find((th) => threadMems(th.id).length);
      if (first) S.openThreads.add(first.id);
    }
    if (prev.view !== r.view) S.conduit = r.view === 'inquiry' ? 'right' : null;
    if (r.view === 'inquiry' && prev.view !== 'inquiry') S.focusInquiry = true;
    else if (r.view === 'record' && r.topic !== prev.topic) S.conduit = 'left';
    render();
  }

  /* ---------- lintel & destination selector ---------- */

  function renderLintel() {
    $('#wordmark').innerHTML = GL.inscription('THREADKEEPER', { height: 40, label: 'Threadkeeper' });
    $('.lintel-identity').style.setProperty('--guilloche', `url("data:image/svg+xml,${encodeURIComponent(GL.guilloche())}")`);
    $('#lintel-seal').innerHTML = GL.seal({ size: 58, label: 'Threadkeeper seal (exploratory mark)' });
    $('#owner-name').textContent = D.owner.name;
    $('#owner-note').textContent = `${D.owner.note} \u00b7 self-hosted instance`;
  }

  function renderDestination() {
    const sel = $('#destination-selector');
    sel.dataset.selected = S.route.view;
    $$('[role="radio"]', sel).forEach((b) => {
      const on = b.dataset.destination === S.route.view;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function bindRadioGroup(group, onPick) {
    group.addEventListener('keydown', (e) => {
      const radios = $$('[role="radio"]', group);
      const i = radios.indexOf(document.activeElement);
      if (i < 0) return;
      let n = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % radios.length;
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + radios.length) % radios.length;
      if (e.key === 'Home') n = 0;
      if (e.key === 'End') n = radios.length - 1;
      if (n === null) return;
      e.preventDefault();
      radios[n].focus();
      onPick(radios[n]);
    });
    group.addEventListener('click', (e) => {
      const b = e.target.closest('[role="radio"]');
      if (b) onPick(b);
    });
  }

  /* ---------- left wing: subject dial ---------- */

  const DIAL = { cx: 52, cy: 150, knob: 40, rowH: 40, top: 30, labelX: 124 };
  const dialPositions = () => [{ id: null, name: 'Overview', note: 'Everything held' }, ...topics.map((t) => ({ id: t.id, name: t.name, note: null }))];
  const dialAngle = (i, n) => -66 + (132 / (n - 1)) * i;

  function dialHTML() {
    const pos = dialPositions();
    const n = pos.length;
    const h = DIAL.top * 2 + DIAL.rowH * (n - 1);
    const ticks = pos.map((p, i) => {
      const a = (dialAngle(i, n) * Math.PI) / 180;
      const pt = (r) => [DIAL.cx + r * Math.cos(a), DIAL.cy + r * Math.sin(a)];
      const [x1, y1] = pt(DIAL.knob + 9);
      const [x2, y2] = pt(DIAL.knob + 15);
      const y = DIAL.top + DIAL.rowH * i;
      return `<g class="dial-tick" data-i="${i}">
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
        <polyline points="${x2},${y2} ${DIAL.labelX - 12},${y} ${DIAL.labelX - 3},${y}"/>
      </g>`;
    }).join('');
    const minor = Array.from({ length: 49 }, (_, k) => {
      const a = ((-72 + k * 3) * Math.PI) / 180;
      const r1 = DIAL.knob + 6, r2 = DIAL.knob + (k % 4 === 0 ? 10 : 8);
      return `<line x1="${DIAL.cx + r1 * Math.cos(a)}" y1="${DIAL.cy + r1 * Math.sin(a)}" x2="${DIAL.cx + r2 * Math.cos(a)}" y2="${DIAL.cy + r2 * Math.sin(a)}"/>`;
    }).join('');
    const radios = pos.map((p, i) => `<button type="button" role="radio" class="dial-pos" data-i="${i}" style="--row:${i}" aria-checked="false" tabindex="-1">
        <span class="mark mark-diamond" aria-hidden="true"></span>
        <span class="dial-name">${esc(p.name)}</span>
      </button>`).join('');

    return enclosure('enclosure-wing', `
      <div class="wing-plate">
        <h2 class="plate-title">Subjects</h2>
        <p class="plate-note">Turn the selector, or choose a name, to open what Threadkeeper holds on that subject.</p>
      </div>
      <div class="dial" style="--dial-h:${h}px">
        <svg class="dial-legend" viewBox="0 0 320 ${h}" width="320" height="${h}" aria-hidden="true">
          <g class="dial-minor">${minor}</g>${ticks}
        </svg>
        <div class="knob" aria-hidden="true" style="left:${DIAL.cx - DIAL.knob}px; top:${DIAL.cy - DIAL.knob}px; width:${DIAL.knob * 2}px; height:${DIAL.knob * 2}px">
          <div class="knob-knurl"><div class="knob-cap"><div class="knob-face">
            <span class="knob-index"></span>
            <span class="knob-boss"></span>
          </div></div></div>
        </div>
        <div class="dial-positions" role="radiogroup" aria-label="Subject">${radios}<span class="dial-carriage" aria-hidden="true"></span></div>
      </div>
    `, '<span class="conduit conduit-left" aria-hidden="true"><span class="conduit-pulse"></span></span>');
  }

  function dialIndex() {
    const pos = dialPositions();
    const i = pos.findIndex((p) => p.id === (S.route.topic || null));
    return Math.max(0, i);
  }

  function updateDial(index = dialIndex(), { live = false } = {}) {
    const dial = $('.dial');
    if (!dial) return;
    const n = dialPositions().length;
    $('.knob-face', dial).style.setProperty('--angle', `${dialAngle(index, n)}deg`);
    dial.classList.toggle('turning', live);
    $$('.dial-pos', dial).forEach((b, i) => {
      const on = i === index;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $$('.dial-tick', dial).forEach((t, i) => t.classList.toggle('on', i === index));
    placeCarriage(dial);
  }

  function placeCarriage(dial) {
    const group = $('.dial-positions', dial);
    const on = $('.dial-pos[aria-checked="true"]', group);
    const car = $('.dial-carriage', group);
    if (!on || !car) return;
    car.style.setProperty('--x', `${on.offsetLeft}px`);
    car.style.setProperty('--w', `${on.offsetWidth}px`);
    if (getComputedStyle(group).flexDirection === 'row' && on.scrollIntoView) {
      const left = on.offsetLeft - group.clientWidth / 2 + on.offsetWidth / 2;
      group.scrollTo({ left, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    }
  }

  function bindDial() {
    const dial = $('.dial');
    const group = $('.dial-positions', dial);
    const pos = dialPositions();
    const pick = (i) => go(pos[i].id ? hrefTopic(pos[i].id) : '#/record');
    bindRadioGroup(group, (b) => pick(Number(b.dataset.i)));

    const knob = $('.knob', dial);
    let drag = null;
    const indexAt = (e) => {
      const r = knob.getBoundingClientRect();
      const deg = (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI;
      const n = pos.length;
      let best = 0;
      for (let i = 1; i < n; i++) if (Math.abs(dialAngle(i, n) - deg) < Math.abs(dialAngle(best, n) - deg)) best = i;
      return best;
    };
    knob.addEventListener('pointerdown', (e) => {
      drag = { moved: false, start: dialIndex(), i: dialIndex(), x: e.clientX, y: e.clientY };
      knob.setPointerCapture(e.pointerId);
      knob.classList.add('gripped');
    });
    knob.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.moved = true;
      if (!drag.moved) return;
      const i = indexAt(e);
      if (i !== drag.i) { drag.i = i; updateDial(i, { live: true }); }
    });
    const release = () => {
      if (!drag) return;
      knob.classList.remove('gripped');
      const i = drag.moved ? drag.i : (drag.start + 1) % pos.length;
      drag = null;
      pick(i);
    };
    knob.addEventListener('pointerup', release);
    knob.addEventListener('pointercancel', release);
  }

  /* ---------- right wing (record): ask plate and agent access ---------- */

  function askPlateHTML() {
    const agents = D.agents.map((a) => `<li><span class="agent-name">${esc(a.name)}</span><span class="agent-where">${esc(a.where)}</span><span class="agent-access">${esc(a.access)}</span></li>`).join('');
    return enclosure('enclosure-wing', `
      <form class="ask-plate" id="ask-plate">
        <h2 class="plate-title">Inquiry</h2>
        <label class="plate-note" for="ask-plate-input">Ask a specific question about your context. Inquiry answers with the same recall your agents use.</label>
        <div class="speaking-grille"><textarea id="ask-plate-input" rows="3" placeholder="When is the Harbor Atlas beta due?"></textarea></div>
        ${commandSeal({ id: 'ask-plate-cmd', label: 'Ask', state: 'Opens Inquiry', type: 'submit' })}
      </form>
      <div class="access-plaque">
        <h2 class="plate-title plate-title-minor">Available to your agents</h2>
        <ul class="agents">${agents}</ul>
        <p class="plate-note">Every current memory reaches these agents with its origin label. Available does not mean endorsed by you.</p>
      </div>
    `, '<span class="conduit conduit-right" aria-hidden="true"><span class="conduit-pulse"></span></span>');
  }

  function bindAskPlate() {
    const form = $('#ask-plate');
    const input = $('#ask-plate-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim() || input.placeholder;
      const btn = $('#ask-plate-cmd');
      await runCommand(btn, { pending: 'Searching your context', done: 'Answer ready', action: () => { S.chat.push(answer(q)); return true; } });
      input.value = '';
      go('#/inquiry', { focus: true });
    });
  }

  /* ---------- inquiry wings ---------- */

  function inquiryGuideHTML() {
    const qs = D.suggestedQuestions.map((q) => `<li><button type="button" class="suggestion" data-q="${esc(q)}">${esc(q)}</button></li>`).join('');
    return enclosure('enclosure-wing', `
      <div class="wing-plate">
        <h2 class="plate-title">How Inquiry answers</h2>
        <p class="plate-note">Inquiry is not a general assistant. It answers only from your Record, through <code>context_search</code>: the same MCP recall, origin labels and scope your agents receive.</p>
      </div>
      <div class="wing-plate">
        <h2 class="plate-title plate-title-minor">Questions to try</h2>
        <ul class="suggestions">${qs}</ul>
      </div>
    `, '<span class="conduit conduit-left" aria-hidden="true"><span class="conduit-pulse"></span></span>');
  }

  function citationsHTML() {
    const last = S.chat[S.chat.length - 1];
    const live = last ? last.cites.map(memById).filter(Boolean) : [];
    const body = live.length
      ? `<ol class="citations">${live.map((m, i) => `<li><a href="${hrefMem(m)}"><span class="cite-n">${i + 1}</span><span class="cite-text">${esc(current(m).statement)}</span>${originTag(m.origin)}<span class="cite-go">Open in the Record</span></a></li>`).join('')}</ol>`
      : `<p class="plate-note">${last && last.cites.length ? 'The memories cited in the latest answer have since been forgotten.' : 'Each answer cites the memories it used. They appear here, linked to their place in the Record.'}</p>`;
    return enclosure('enclosure-wing', `
      <div class="wing-plate">
        <h2 class="plate-title">Cited context</h2>
        ${body}
      </div>
    `, '<span class="conduit conduit-right" aria-hidden="true"><span class="conduit-pulse"></span></span>');
  }

  function renderWings() {
    const view = S.route.view;
    const left = $('#wing-left');
    const right = $('#wing-right');
    if (S.wingsView !== view) {
      S.wingsView = view;
      if (view === 'record') {
        left.setAttribute('aria-label', 'Subject selector');
        right.setAttribute('aria-label', 'Inquiry and agent access');
        left.innerHTML = dialHTML();
        right.innerHTML = askPlateHTML();
        bindDial();
        bindAskPlate();
      } else {
        left.setAttribute('aria-label', 'About Inquiry');
        right.setAttribute('aria-label', 'Cited context');
        left.innerHTML = inquiryGuideHTML();
        $$('.suggestion', left).forEach((b) => b.addEventListener('click', () => {
          const input = $('#inquiry-input');
          input.value = b.dataset.q;
          $('#inquiry-form').requestSubmit();
        }));
      }
    }
    if (view === 'record') updateDial();
    else right.innerHTML = citationsHTML();
  }

  function pulseConduit() {
    const side = S.conduit;
    S.conduit = null;
    if (!side || reducedMotion.matches) return;
    const c = $(`.conduit-${side}`);
    if (!c) return;
    c.classList.remove('pulsing');
    void c.offsetWidth;
    c.classList.add('pulsing');
  }

  /* ---------- chamber: the Record ---------- */

  function strataHead(levels) {
    return levels.map((l, i) => `<a class="stratum-strip" href="${l.href}" style="--depth:${i}" data-focus-chamber>
      <span class="strip-kicker">${esc(l.kicker)}</span><span class="strip-name">${esc(l.name)}</span><span class="strip-return">Return</span>
    </a>`).join('');
  }

  function noticeHTML() {
    if (!S.notice) return '';
    const n = S.notice;
    S.notice = null;
    return `<div class="notice notice-${n.tone}" role="status"><span class="notice-mark" aria-hidden="true"></span><p>${n.html}</p></div>`;
  }

  function overviewHTML() {
    const held = memories.length;
    const srcCount = liveSourceIds().size;
    const ranked = topics.map((t) => ({ t, n: topicMems(t.id).length })).sort((a, b) => b.n - a.n);
    const [principal, ...rest] = ranked;
    const secondary = rest.slice(0, 2);
    const tertiary = rest.slice(2);
    const agentsUsed = new Set([...liveSourceIds()].map((id) => sources[id].agent).filter(Boolean)).size;

    const threadList = (t) => t.threads.map((th) => {
      const n = threadMems(th.id).length;
      return `<li><span>${esc(th.name)}</span><span class="leader" aria-hidden="true"></span><span class="tally">${n ? count(n, 'memory', 'memories') : 'nothing held'}</span></li>`;
    }).join('');

    const tally = {};
    memories.forEach((m) => { tally[m.origin] = (tally[m.origin] || 0) + 1; });
    const order = ['user_explicit', 'user_confirmed', 'agent_reported', 'inferred', 'assistant_proposed'];
    const assay = order.filter((o) => tally[o]).map((o) => `<span class="assay-seg assay-${o}" style="flex:${tally[o]}" title="${esc(D.origins[o].short)}: ${tally[o]}"></span>`).join('');
    const assayKey = order.filter((o) => tally[o]).map((o) => `<li>${originTag(o)}<span class="tally">${tally[o]}</span></li>`).join('');

    const lately = [...memories].sort((a, b) => current(b).at.localeCompare(current(a).at)).slice(0, 3).map((m) =>
      `<li><a href="${hrefMem(m)}" data-focus-chamber><span class="lately-date">${fmtDate(current(m).at)}</span><span class="lately-text">${esc(current(m).statement)}</span><span class="lately-topic">${esc(topicById(m.topic).name)}</span></a></li>`).join('');

    return `
      <div class="stratum stratum-overview" style="--depth:0">
        <header class="stratum-head">
          <p class="kicker">The Record</p>
          <h2 id="chamber-title" class="chamber-title">What Threadkeeper holds for you</h2>
        </header>
        ${noticeHTML()}
        <p class="precis">Threadkeeper holds <em>${count(held, 'memory', 'memories')}</em> about you across <em>${count(topics.length, 'subject')}</em>, drawn from ${count(srcCount, 'source event')} that ${count(agentsUsed, 'agent')} captured or that you wrote here. All of it is available to your agents now; each memory says how it arrived.</p>

        <section class="principal" aria-labelledby="principal-name">
          <a class="principal-plate" href="${hrefTopic(principal.t.id)}" data-focus-chamber>
            <span class="kicker">${esc(principal.t.kind)} \u00b7 most held</span>
            <span class="principal-name" id="principal-name">${esc(principal.t.name)}</span>
            <span class="principal-gist">${esc(gist(principal.t))}${gistNote(principal.t)}</span>
            <ul class="thread-index">${threadList(principal.t)}</ul>
            <span class="open-cue">Open subject</span>
          </a>
        </section>

        <div class="secondary">
          ${secondary.map(({ t, n }) => `<a class="secondary-plate" href="${hrefTopic(t.id)}" data-focus-chamber>
            <span class="kicker">${esc(t.kind)} \u00b7 ${n ? count(n, 'memory', 'memories') : 'nothing held'}</span>
            <span class="secondary-name">${esc(t.name)}</span>
            <span class="secondary-gist">${esc(gist(t))}${gistNote(t)}</span>
          </a>`).join('')}
        </div>

        <ul class="tertiary">
          ${tertiary.map(({ t, n }) => `<li><a href="${hrefTopic(t.id)}" data-focus-chamber><span class="tertiary-name">${esc(t.name)}</span><span class="tertiary-gist">${esc(gist(t))}</span><span class="tally">${n || 'none'}</span></a></li>`).join('')}
        </ul>

        <div class="lower-register">
          <section class="assay" aria-labelledby="assay-title">
            <h3 id="assay-title" class="minor-title">How these memories arrived</h3>
            <div class="assay-bar" aria-hidden="true">${assay}</div>
            <ul class="assay-key">${assayKey}</ul>
          </section>
          <section class="lately" aria-labelledby="lately-title">
            <h3 id="lately-title" class="minor-title">Most recently changed</h3>
            <ol>${lately}</ol>
          </section>
        </div>
      </div>`;
  }

  function memoryLine(m) {
    const c = current(m);
    return `<li><a class="memory-line" href="${hrefMem(m)}" data-focus-chamber>
      <span class="memory-line-text">${esc(c.statement)}</span>
      <span class="memory-line-meta">${originTag(m.origin)}<span class="kind">${esc(m.kind)}</span></span>
    </a></li>`;
  }

  function topicHTML(t) {
    const all = topicMems(t.id);
    const threads = t.threads.map((th) => {
      const ms = threadMems(th.id);
      const open = S.openThreads.has(th.id) && ms.length > 0;
      return `<section class="thread ${open ? 'open' : ''}">
        <h3 class="thread-head">
          <button type="button" class="thread-toggle" aria-expanded="${open}" aria-controls="th-${th.id}" data-thread="${th.id}" ${ms.length ? '' : 'disabled'}>
            <span class="thread-mark" aria-hidden="true"></span>
            <span class="thread-name">${esc(th.name)}</span>
            <span class="thread-summary">${esc(th.summary)}</span>
            <span class="tally">${ms.length ? count(ms.length, 'memory', 'memories') : 'nothing held'}</span>
          </button>
        </h3>
        <ol class="memory-lines" id="th-${th.id}" ${open ? '' : 'hidden'}>${ms.map(memoryLine).join('')}</ol>
      </section>`;
    }).join('');

    return `
      ${strataHead([{ href: '#/record', kicker: 'The Record', name: 'Overview' }])}
      <div class="stratum stratum-topic" style="--depth:1">
        <header class="stratum-head">
          <p class="kicker">${esc(t.kind)} \u00b7 ${all.length ? count(all.length, 'memory', 'memories') : 'nothing held'}</p>
          <h2 id="chamber-title" class="chamber-title">${esc(t.name)}</h2>
          <p class="topic-gist">${esc(gist(t))}${gistNote(t)}</p>
        </header>
        ${noticeHTML()}
        <div class="threads">${threads}</div>
      </div>`;
  }

  function particulars(m) {
    const c = current(m);
    const o = D.origins[m.origin];
    const rows = [
      ['How it arrived', `${originTag(m.origin)}<span class="dd-note">${esc(o.long)}</span>`],
      ['Availability', `<span class="avail">Available to ${count(D.agents.length, 'agent')}</span><span class="dd-note">Delivered automatically with its label. You have not been asked to approve it.</span>`],
      m.effective ? ['Effective', esc(fmtDate(m.effective))] : null,
      ['Current wording', `Revision ${c.rev}, ${esc(fmtDate(c.at))}`]
    ].filter(Boolean);
    return `<dl class="particulars">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }

  function forgetImpact(m) {
    const srcIds = new Set(sourceIdsOf(m));
    const siblings = memories.filter((o) => o !== m && sourceIdsOf(o).some((s) => srcIds.has(s)));
    siblings.forEach((o) => sourceIdsOf(o).forEach((s) => srcIds.add(s)));
    const affected = [m, ...siblings];
    const revisions = affected.reduce((n, x) => n + x.revisions.length, 0);
    return { affected, siblings, srcIds: [...srcIds], revisions };
  }

  function actionPanel(m) {
    if (S.mode === 'correct') {
      return `<form class="action-panel correct-panel" id="correct-form">
        <h3 class="minor-title">Correct this memory</h3>
        <p class="panel-note">Your wording takes effect immediately and becomes authoritative. No model reviews it. The original source stays preserved alongside your correction.</p>
        <label class="field-label" for="correct-input">Corrected wording</label>
        <div class="engraving-field"><textarea id="correct-input" rows="3">${esc(current(m).statement)}</textarea></div>
        <label class="field-label" for="correct-effective">Effective date</label>
        <div class="engraving-field engraving-field-short"><input id="correct-effective" inputmode="numeric" autocomplete="off" spellcheck="false" value="${m.effective ? esc(m.effective) : ''}" placeholder="None"></div>
        <p class="dd-note">Year-month-day, as 2026-11-14. Leave blank when there is no effective date.</p>
        <div class="panel-actions">
          ${commandSeal({ id: 'correct-cmd', label: 'Record correction', state: `Becomes revision ${current(m).rev + 1}`, type: 'submit' })}
          <button type="button" class="quiet-button" data-mode="">Cancel</button>
        </div>
      </form>`;
    }
    if (S.mode === 'forget') {
      const imp = forgetImpact(m);
      const srcLines = imp.srcIds.map((id) => `<li><q>${esc(sources[id].quote)}</q><span class="dd-note">${esc(sources[id].method)} \u00b7 ${esc(agentName(sources[id].agent))} \u00b7 ${esc(fmtDate(sources[id].at))}</span></li>`).join('');
      const sib = imp.siblings.length
        ? `<p class="panel-warning">The same source also supports ${count(imp.siblings.length, 'other memory', 'other memories')}, which will be forgotten with it:</p><ul class="sibling-list">${imp.siblings.map((s) => `<li>${esc(current(s).statement)}</li>`).join('')}</ul>`
        : '';
      return `<div class="action-panel forget-panel">
        <h3 class="minor-title">Forget this memory</h3>
        <p class="panel-note">Forgetting removes the memory, every revision of it, and the source events it rests on. Agents stop receiving it at once. Copies already delivered into agent conversations are beyond Threadkeeper's reach.</p>
        <h4 class="micro-title">Source events removed</h4>
        <ul class="source-list">${srcLines}</ul>
        ${sib}
        <div class="panel-actions">
          ${commandSeal({ id: 'forget-cmd', label: 'Forget permanently', state: `${count(imp.affected.length, 'memory', 'memories')}, ${count(imp.srcIds.length, 'source event')}`, tone: 'oxblood', centre: 'forget' })}
          <button type="button" class="quiet-button" data-mode="">Keep it</button>
        </div>
      </div>`;
    }
    return '';
  }

  function provenanceHTML(m) {
    const rows = m.revisions.map((r, idx) => {
      const isCurrent = idx === m.revisions.length - 1;
      const srcs = r.sources.map((id) => {
        const s = sources[id];
        return `<div class="prov-source-body">
          <p class="prov-meta"><span class="prov-role">${esc(s.role)}</span> \u00b7 ${esc(agentName(s.agent))} \u00b7 ${esc(s.method)}</p>
          <blockquote class="prov-quote">${esc(s.quote)}</blockquote>
          <p class="prov-stamp"><span class="preserved">Preserved as captured</span><span>${esc(fmtDate(s.at))}, ${esc(s.at.slice(11))}</span><span class="prov-id">${esc(id)}</span></p>
        </div>`;
      }).join('');
      return `<li class="prov-row ${isCurrent ? 'is-current' : 'is-superseded'} judgment-${r.judgment.kind}">
        <div class="prov-cell prov-source">
          ${enclosure('enclosure-evidence', `<p class="prov-label">Source event</p>${srcs}`, '<span class="port port-out" aria-hidden="true"></span>')}
        </div>
        <div class="prov-cell prov-junction">
          <span class="junction-seal">${GL.seal({ size: 46, centre: r.judgment.kind === 'correction' ? 'check' : 'monogram' })}</span>
          <span class="junction-label">${esc(r.judgment.label)}</span>
          <span class="junction-detail">${esc(r.judgment.detail)}</span>
        </div>
        <div class="prov-cell prov-interp">
          <div class="interp-surface">
            <span class="port port-in" aria-hidden="true"></span>
            <p class="prov-label">Revision ${r.rev} \u00b7 ${isCurrent ? 'current' : 'superseded'}</p>
            <p class="interp-text">${esc(r.statement)}</p>
            <p class="prov-stamp"><span>${esc(fmtDate(r.at))}</span><span>${isCurrent ? 'Delivered to your agents' : 'Kept in history, no longer delivered'}</span></p>
          </div>
        </div>
      </li>`;
    }).join('');
    return `<section class="stratum stratum-provenance" style="--depth:3" aria-labelledby="prov-title">
      <header class="stratum-head">
        <p class="kicker">Sources and history</p>
        <h3 id="prov-title" class="minor-title">How this memory was formed</h3>
        <p class="panel-note">Each source is kept exactly as captured. The seal between source and wording names the judgment that produced it. ${m.revisions.length > 1 ? 'Your correction is a new source event; it does not overwrite the original.' : ''}</p>
      </header>
      <div class="prov-field">
        <svg class="prov-routes" aria-hidden="true"></svg>
        <ol class="prov-rows">${rows}</ol>
      </div>
    </section>`;
  }

  function memoryHTML(m) {
    const t = topicById(m.topic);
    const th = t.threads.find((x) => x.id === m.thread);
    const c = current(m);
    const r = S.route;
    const provHref = r.sources ? hrefMem(m) : `${hrefMem(m)}/sources`;
    return `
      ${strataHead([{ href: '#/record', kicker: 'The Record', name: 'Overview' }, { href: hrefTopic(t.id), kicker: t.kind, name: t.name }])}
      <div class="stratum stratum-memory" style="--depth:2">
        <header class="stratum-head">
          <p class="kicker">${esc(m.kind)} \u00b7 ${esc(th.name)}</p>
          <h2 id="chamber-title" class="sr-only">Memory: ${esc(c.statement)}</h2>
        </header>
        ${noticeHTML()}
        <blockquote class="statement ${m.origin === 'assistant_proposed' ? 'is-proposal' : ''}"><p>${esc(c.statement)}</p></blockquote>
        ${particulars(m)}
        <div class="memory-controls">
          <a class="disclose" href="${provHref}" aria-expanded="${r.sources}" data-focus-chamber="keep">
            <span class="disclose-mark" aria-hidden="true"></span>${r.sources ? 'Hide sources and history' : `Show sources and history`}
            <span class="dd-note">${count(sourceIdsOf(m).length, 'source event')}, ${count(m.revisions.length, 'revision')}</span>
          </a>
          <span class="control-rule" aria-hidden="true"></span>
          <button type="button" class="lever" data-mode="correct" aria-pressed="${S.mode === 'correct'}">Correct</button>
          <button type="button" class="lever lever-oxblood" data-mode="forget" aria-pressed="${S.mode === 'forget'}">Forget\u2026</button>
        </div>
        ${actionPanel(m)}
      </div>
      ${r.sources ? provenanceHTML(m) : ''}`;
  }

  /* ---------- chamber: Inquiry ---------- */

  function inquiryHTML() {
    const ex = S.chat.map((x, i) => exchangeHTML(x, i === S.chat.length - 1)).join('');
    return `
      <div class="stratum stratum-inquiry" style="--depth:0">
        <header class="stratum-head">
          <p class="kicker">Inquiry</p>
          <h2 id="chamber-title" class="chamber-title">Ask about your context</h2>
        </header>
        <form class="inquiry-form" id="inquiry-form">
          <label class="sr-only" for="inquiry-input">Your question</label>
          <div class="speaking-grille"><textarea id="inquiry-input" rows="4" placeholder="Ask about a date, preference or constraint\u2026"></textarea></div>
          ${commandSeal({ id: 'inquiry-cmd', label: 'Ask', state: 'Searches your Record', type: 'submit' })}
        </form>
        <p class="inquiry-note" role="note"><span class="sim-badge">Simulated</span> Answers are composed in this page from the synthetic Record, labelled with their origin, and linked back to the memory. No server, MCP endpoint or model is called. In Threadkeeper this would call <code>context_search</code>.</p>
        ${ex ? `<ol class="transcript">${ex}</ol>` : ''}
      </div>`;
  }

  function point(m) {
    const raw = current(m).statement.trim();
    const s = esc(raw);
    const sentence = esc(raw.charAt(0).toLowerCase() + raw.slice(1)) + (/[.!?]$/.test(raw) ? '' : '.');
    switch (m.origin) {
      case 'user_explicit': return `You said: ${s}`;
      case 'user_confirmed': return `In your corrected wording: ${s}`;
      case 'agent_reported': return `An agent reported that ${sentence} You have not stated this yourself.`;
      case 'inferred': return `Inferred from conversation, not stated by you: ${s}`;
      case 'assistant_proposed': return `An assistant suggested: \u201c${s}\u201d You have not accepted this suggestion.`;
      default: return s;
    }
  }

  function exchangeHTML(x, announceAnswer) {
    const live = x.cites.map(memById);
    const points = live.map((m, k) => (m
      ? `<li>${point(m)} <a class="cite" href="${hrefMem(m)}" data-focus-chamber aria-label="Cited memory ${k + 1}: open in the Record">${k + 1}</a></li>`
      : '<li class="cite-gone">A memory cited here has since been forgotten. Its wording is no longer shown.</li>')).join('');
    const body = x.cites.length
      ? `<p>Here is what your Record says:</p><ul class="answer-points">${points}</ul>`
      : '<p>Your Record holds nothing on that. An agent asking the same question would receive an empty result, and should say so rather than guess.</p>';
    return `<li class="exchange">
      <p class="asked"><span class="who">You asked</span>${esc(x.q)}</p>
      ${enclosure('enclosure-answer', `
        <p class="answer-tag"><span class="sim-badge">Simulated answer</span>${x.cites.length ? `From ${count(x.cites.length, 'memory', 'memories')}` : 'No matching memories'}</p>
        <div class="answer-body" ${announceAnswer ? 'aria-live="polite"' : ''}>${body}</div>
        <p class="mcp-equivalent">Agent equivalent <code>context_search {"query": ${esc(JSON.stringify(x.q))}}</code></p>
      `)}
    </li>`;
  }

  const STOP = new Set('a an and are as at be by can could did do does for from have how i in is it me my of on or our should so that the their them there this to was we what when where which who why will with would you your about know agents agent tell any anything has been not'.split(' '));
  const stem = (w) => (w.length > 4 ? w.slice(0, 4) : w);
  const tokens = (s) => s.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).map(stem);

  const SYNONYMS = { book: ['call', 'unav'], eat: ['pesc'], food: ['pesc'] };
  const CURATED = {
    'when is the harbor atlas beta due': ['mem-beta'],
    'how should agents write for me': ['mem-paragraphs', 'mem-british', 'mem-plainverbs', 'mem-commits'],
    'when should agents avoid booking calls': ['mem-pickup']
  };

  function answer(q) {
    const curated = CURATED[q.trim().toLowerCase().replace(/[?]/g, '')];
    if (curated) return { q, cites: curated };
    const qt = tokens(q).flatMap((w) => [w, ...(SYNONYMS[w] || [])]);
    let hits;
    if (/suggest|propos|accept/i.test(q)) {
      hits = memories.filter((m) => m.origin === 'assistant_proposed');
    } else {
      const scored = memories.map((m) => {
        const t = topicById(m.topic);
        const th = t.threads.find((x) => x.id === m.thread);
        const hay = new Set(tokens(`${current(m).statement} ${th.name} ${m.kind}`));
        return { m, s: qt.filter((w) => hay.has(w)).length };
      }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      const max = scored.length ? scored[0].s : 0;
      hits = scored.filter((x) => x.s >= max * 0.75).slice(0, 4).map((x) => x.m);
    }
    return { q, cites: hits.map((m) => m.id) };
  }

  function bindInquiry() {
    const form = $('#inquiry-form');
    if (!form) return;
    const input = $('#inquiry-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) { input.focus(); return; }
      await runCommand($('#inquiry-cmd'), { pending: 'Searching your Record', done: 'Answer ready', action: () => { S.chat.push(answer(q)); return true; } });
      S.conduit = 'right';
      render();
      const items = $$('.exchange');
      const last = items[items.length - 1];
      if (last) last.scrollIntoView({ block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      $('#inquiry-input').focus();
    });
  }

  /* ---------- chamber render & behaviour ---------- */

  function renderChamber() {
    const r = S.route;
    const chamber = $('#chamber');
    let html;
    if (r.view === 'inquiry') html = inquiryHTML();
    else if (r.memory) html = memoryHTML(memById(r.memory));
    else if (r.topic) html = topicHTML(topicById(r.topic));
    else html = overviewHTML();
    chamber.innerHTML = html;
    chamber.dataset.depth = r.view === 'inquiry' ? 'inquiry' : r.memory ? (r.sources ? 3 : 2) : r.topic ? 1 : 0;
    bindChamber();
  }

  function bindChamber() {
    const chamber = $('#chamber');
    $$('.thread-toggle', chamber).forEach((b) => b.addEventListener('click', () => {
      const id = b.dataset.thread;
      const open = !S.openThreads.has(id);
      if (open) S.openThreads.add(id); else S.openThreads.delete(id);
      b.setAttribute('aria-expanded', String(open));
      b.closest('.thread').classList.toggle('open', open);
      $(`#th-${id}`).hidden = !open;
    }));
    $$('[data-mode]', chamber).forEach((b) => b.addEventListener('click', () => {
      const next = b.dataset.mode || null;
      S.mode = S.mode === next ? null : next;
      renderChamber();
      afterRender();
      const target = S.mode === 'correct' ? $('#correct-input') : S.mode === 'forget' ? $('#forget-cmd') : $(`.lever[data-mode="${b.dataset.mode || 'correct'}"]`);
      if (target) {
        target.focus();
        if (target.tagName === 'TEXTAREA') target.setSelectionRange(target.value.length, target.value.length);
      }
    }));
    const cf = $('#correct-form');
    if (cf) cf.addEventListener('submit', (e) => { e.preventDefault(); submitCorrection(); });
    const fb = $('#forget-cmd');
    if (fb) fb.addEventListener('click', submitForget);
    bindInquiry();
  }

  async function submitCorrection() {
    const m = memById(S.route.memory);
    const input = $('#correct-input');
    const text = input.value.trim();
    const date = $('#correct-effective').value.trim();
    const state = $('.cmd-state', $('#correct-cmd'));
    if (!text) {
      input.focus();
      state.textContent = 'Enter the corrected wording';
      return;
    }
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      $('#correct-effective').focus();
      state.textContent = 'Use the form 2026-11-14';
      return;
    }
    if (text === current(m).statement && date === (m.effective || '')) {
      input.focus();
      state.textContent = 'Nothing changed';
      return;
    }
    const ok = await runCommand($('#correct-cmd'), {
      pending: 'Recording',
      done: () => `Recorded as revision ${current(m).rev}`,
      action: () => {
        const at = nowStamp();
        const id = `src-pf-${Date.now().toString(36)}`;
        sources[id] = { agent: null, role: 'You', method: 'Profile correction', at, quote: text };
        m.revisions.push({ rev: current(m).rev + 1, at, statement: text, sources: [id], judgment: { kind: 'correction', label: 'Your correction', detail: 'Authoritative owner edit' } });
        m.origin = 'user_confirmed';
        m.effective = date || null;
        S.rebuilt.add(m.topic);
        return true;
      }
    });
    if (!ok) return;
    S.mode = null;
    S.notice = { tone: 'electrum', html: `Corrected. Your agents now receive your wording. The original source is preserved under <a href="${hrefMem(m)}/sources" data-focus-chamber="keep">sources and history</a>.` };
    S.focusChamber = true;
    renderChamber();
    afterRender();
    updateDial();
  }

  async function submitForget() {
    const m = memById(S.route.memory);
    const imp = forgetImpact(m);
    const ok = await runCommand($('#forget-cmd'), {
      pending: 'Forgetting',
      tone: 'oxblood',
      done: 'Forgotten',
      action: () => {
        imp.affected.forEach((x) => memories.splice(memories.indexOf(x), 1));
        imp.srcIds.forEach((id) => { delete sources[id]; });
        imp.affected.forEach((x) => S.rebuilt.add(x.topic));
        return true;
      }
    });
    if (!ok) return;
    const n = imp.affected.length;
    S.notice = { tone: 'oxblood', html: `Forgotten: ${count(n, 'memory', 'memories')} and ${count(imp.srcIds.length, 'source event')}. Agents will no longer receive ${n === 1 ? 'it' : 'them'}.` };
    go(hrefTopic(m.topic), { focus: true });
  }

  function drawRoutes() {
    const field = $('.prov-field');
    if (!field) return;
    const svg = $('.prov-routes', field);
    const box = field.getBoundingClientRect();
    svg.setAttribute('width', box.width);
    svg.setAttribute('height', box.height);
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const rel = (el, fx, fy) => {
      const r = el.getBoundingClientRect();
      return [r.left - box.left + r.width * fx, r.top - box.top + r.height * fy];
    };
    let paths = '';
    $$('.prov-row', field).forEach((row) => {
      const out = $('.port-out', row);
      const inn = $('.port-in', row);
      const j = $('.junction-seal', row);
      const stacked = $('.prov-source', row).getBoundingClientRect().bottom <= j.getBoundingClientRect().top + 1;
      const cls = row.classList.contains('is-current') ? 'route route-current' : 'route';
      let a, jIn, jOut, b, d1, d2;
      if (stacked) {
        a = rel(out, 0.5, 1); jIn = rel(j, 0.5, 0); jOut = rel(j, 0.5, 1); b = rel(inn, 0.5, 0);
        const m1 = (a[1] + jIn[1]) / 2, m2 = (jOut[1] + b[1]) / 2;
        d1 = `M${a[0]} ${a[1]} V${m1} H${jIn[0]} V${jIn[1]}`;
        d2 = `M${jOut[0]} ${jOut[1]} V${m2} H${b[0]} V${b[1]}`;
      } else {
        a = rel(out, 1, 0.5); jIn = rel(j, 0, 0.5); jOut = rel(j, 1, 0.5); b = rel(inn, 0, 0.5);
        const m1 = a[0] + (jIn[0] - a[0]) * 0.45, m2 = jOut[0] + (b[0] - jOut[0]) * 0.55;
        d1 = `M${a[0]} ${a[1]} H${m1} V${jIn[1]} H${jIn[0]}`;
        d2 = `M${jOut[0]} ${jOut[1]} H${m2} V${b[1]} H${b[0]}`;
      }
      paths += `<path class="${cls}" d="${d1}"/><path class="${cls}" d="${d2}"/>`;
      paths += `<circle class="route-node" cx="${a[0]}" cy="${a[1]}" r="2.6"/><circle class="route-node" cx="${b[0]}" cy="${b[1]}" r="2.6"/>`;
    });
    svg.innerHTML = paths;
  }

  function afterRender() {
    drawRoutes();
    const chamber = $('#chamber');
    $$('[data-focus-chamber]', chamber).forEach((a) => a.addEventListener('click', () => {
      S.focusChamber = a.dataset.focusChamber === 'keep' ? 'keep' : true;
    }));
    if (S.focusInquiry) {
      S.focusInquiry = false;
      const input = $('#inquiry-input');
      if (input) input.focus({ preventScroll: true });
    } else if (S.focusChamber) {
      const keep = S.focusChamber === 'keep';
      S.focusChamber = false;
      const target = keep ? ($('.disclose', chamber) || chamber) : chamber;
      target.focus({ preventScroll: true });
      const top = $('.chamber-housing').getBoundingClientRect().top;
      if (!keep && top < 0) $('.chamber-housing').scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
      if (keep && S.route.sources) {
        const prov = $('.stratum-provenance', chamber);
        if (prov) prov.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'nearest' });
      }
    }
    pulseConduit();
  }

  function render() {
    const r = S.route;
    $('#hall').dataset.view = r.view;
    document.title = r.view === 'inquiry'
      ? 'Inquiry \u00b7 Threadkeeper prototype'
      : r.memory ? 'Memory \u00b7 Threadkeeper prototype' : r.topic ? `${topicById(r.topic).name} \u00b7 Threadkeeper prototype` : 'The Record \u00b7 Threadkeeper prototype';
    renderDestination();
    renderWings();
    renderChamber();
    afterRender();
  }

  /* ---------- boot ---------- */

  renderLintel();
  bindRadioGroup($('#destination-selector'), (b) => {
    if (b.dataset.destination === S.route.view) return;
    go(b.dataset.destination === 'inquiry' ? '#/inquiry' : '#/record');
  });
  window.addEventListener('hashchange', onRoute);
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { drawRoutes(); const d = $('.dial'); if (d) placeCarriage(d); }, 60);
  });
  if (!location.hash) history.replaceState(null, '', '#/record');
  onRoute();
})();
