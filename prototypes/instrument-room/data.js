/*
 * Synthetic records for the instrument-room prototype.
 * The persona, projects, people and agents are invented. Nothing here is real personal data.
 */
window.TK_DATA = {
  owner: { name: 'Iris Calder', note: 'Synthetic profile' },

  agents: [
    { id: 'codex', name: 'Codex', where: 'Studio laptop', access: 'Recall and capture' },
    { id: 'opencode', name: 'OpenCode', where: 'Terminal', access: 'Recall and capture' },
    { id: 'research', name: 'Research chat', where: 'Browser client', access: 'Recall only' }
  ],

  origins: {
    user_explicit: { short: 'You said this', long: 'You stated this directly to an agent.' },
    user_confirmed: { short: 'Corrected by you', long: 'You corrected this in Threadkeeper. Your wording is authoritative.' },
    agent_reported: { short: 'Reported by an agent', long: 'An agent reported this while working for you. You did not state it yourself.' },
    inferred: { short: 'Inferred, not stated', long: 'Interpreted from conversation. You never said this outright.' },
    assistant_proposed: { short: 'From an assistant', long: 'An assistant contributed this memory while working for you.' }
  },

  topics: [
    {
      id: 'harbor',
      name: 'Harbor Atlas',
      kind: 'Project',
      gist: 'The tide-chart mapping app you lead. Public beta is due 14 November; it runs on TypeScript and PostgreSQL with nightly tide imports.',
      threads: [
        { id: 'harbor-schedule', name: 'Schedule and commitments', summary: 'A fixed beta date and a fortnightly design review.' },
        { id: 'harbor-decisions', name: 'Technical decisions', summary: 'Storage, data import and map rendering choices.' },
        { id: 'harbor-people', name: 'People and context', summary: 'Who owns what, and support for chart styling.' }
      ]
    },
    {
      id: 'writing',
      name: 'Writing voice',
      kind: 'Preferences',
      gist: 'Short paragraphs, British spelling and plain verbs. Commit messages and release notes follow their own rules.',
      threads: [
        { id: 'writing-style', name: 'Style', summary: 'How prose addressed to you, or written for you, should read.' },
        { id: 'writing-formats', name: 'Formats', summary: 'Conventions for commits and release notes.' }
      ]
    },
    {
      id: 'practice',
      name: 'Engineering practice',
      kind: 'Working habits',
      gist: 'Tests before fixes, SQL over ORMs, pnpm on Node 24.',
      threads: [
        { id: 'practice-code', name: 'Code', summary: 'Tooling and code-structure preferences.' },
        { id: 'practice-rhythm', name: 'Rhythm', summary: 'When and how you review work.' }
      ]
    },
    {
      id: 'home',
      name: 'Home and schedule',
      kind: 'Constraints',
      gist: 'School collection on Tuesdays and Thursdays, and quiet hours after 21:00.',
      threads: [
        { id: 'home-hours', name: 'Unavailable hours', summary: 'Times agents should not book calls or send reminders.' }
      ]
    },
    {
      id: 'travel',
      name: 'Travel and food',
      kind: 'Preferences',
      gist: 'Pescatarian, prefers trains under six hours, Lisbon in March.',
      threads: [
        { id: 'travel-all', name: 'Travel and food', summary: 'Diet, transport and one planned trip.' }
      ]
    },
    {
      id: 'learning',
      name: 'Learning Portuguese',
      kind: 'Study',
      gist: 'European Portuguese at B1, with corrections given inline.',
      threads: [
        { id: 'learning-all', name: 'Study', summary: 'Level and how you want to be corrected.' }
      ]
    }
  ],

  sources: {
    'src-cx-0912': { agent: 'codex', role: 'You', method: 'Explicit capture', at: '2026-09-12 10:14', quote: 'Remember this: the Harbor Atlas public beta ships on 14 November. That date is fixed.' },
    'src-oc-0915': { agent: 'opencode', role: 'Agent', method: 'Agent report', at: '2026-09-15 16:02', quote: 'Calendar shows the Harbor Atlas design review recurring every second Thursday, 15:00 CET.' },
    'src-cx-0820': { agent: 'codex', role: 'You', method: 'Explicit capture', at: '2026-08-20 09:41', quote: 'We are keeping vectors inside Postgres with pgvector. No separate vector database for Atlas.' },
    'src-rc-0803': { agent: 'research', role: 'You', method: 'Extracted from conversation', at: '2026-08-03 21:17', quote: 'I think we can just call the harbour authority API live whenever someone opens a chart.' },
    'src-pf-0904': { agent: null, role: 'You', method: 'Profile correction', at: '2026-09-04 08:30', quote: 'Tide data is imported nightly from published harmonic constants. No live API calls.' },
    'src-oc-0826': { agent: 'opencode', role: 'You', method: 'Extracted from conversation', at: '2026-08-26 14:55', quote: 'Half our users are on old Android phones; the WebGL layer is going to hurt them.' },
    'src-oc-0910': { agent: 'opencode', role: 'Agent', method: 'Agent report', at: '2026-09-10 11:20', quote: 'Assigned per project board: Mara Oyelaran owns the Harbor Atlas iOS build.' },
    'src-rc-0918': { agent: 'research', role: 'Assistant', method: 'Extracted from conversation', at: '2026-09-18 19:06', quote: 'You might consider bringing in a contract cartographer before beta to review the chart styling.' },
    'src-cx-0702': { agent: 'codex', role: 'You', method: 'Explicit capture', at: '2026-07-02 13:08', quote: 'Keep paragraphs short when you write for me, and use British spelling.' },
    'src-rc-0722': { agent: 'research', role: 'You', method: 'Extracted from conversation', at: '2026-07-22 17:45', quote: 'Can you rewrite that without "leverage" and "utilise"? Just say what it does.' },
    'src-cx-0715': { agent: 'codex', role: 'You', method: 'Explicit capture', at: '2026-07-15 10:31', quote: 'Commit messages: imperative mood, under sixty characters for the subject line.' },
    'src-cx-0801': { agent: 'codex', role: 'You', method: 'Extracted from conversation', at: '2026-08-01 15:12', quote: 'Release notes should list every internal refactor first so the team gets credit.' },
    'src-pf-0802': { agent: null, role: 'You', method: 'Profile correction', at: '2026-08-02 09:05', quote: 'Release notes lead with what changed for users. Internal work goes last, briefly.' },
    'src-oc-0728': { agent: 'opencode', role: 'Agent', method: 'Agent report', at: '2026-07-28 12:00', quote: 'Workspace uses pnpm 11 with Node.js 24 (packageManager pin present).' },
    'src-oc-0611': { agent: 'opencode', role: 'You', method: 'Explicit capture', at: '2026-06-11 16:40', quote: 'Before you fix a reported bug, write the failing test first. Every time.' },
    'src-cx-0619': { agent: 'codex', role: 'You', method: 'Explicit capture', at: '2026-06-19 11:22', quote: 'No ORMs. Keep SQL in repository modules where I can read it.' },
    'src-oc-0905': { agent: 'opencode', role: 'You', method: 'Extracted from conversation', at: '2026-09-05 08:12', quote: 'Morning — going through the open PRs now before the standup.' },
    'src-cx-0901': { agent: 'codex', role: 'You', method: 'Explicit capture', at: '2026-09-01 12:47', quote: 'Never book anything Tuesday or Thursday from 15:30 to 16:30. That is school pickup.' },
    'src-rc-0620': { agent: 'research', role: 'You', method: 'Explicit capture', at: '2026-06-20 20:58', quote: 'No reminders or messages after 21:00, please.' },
    'src-rc-0510': { agent: 'research', role: 'You', method: 'Extracted from conversation', at: '2026-05-10 13:30', quote: 'I am vegetarian, so skip the steakhouse.' },
    'src-pf-0512': { agent: null, role: 'You', method: 'Profile correction', at: '2026-05-12 18:02', quote: 'Pescatarian: I eat fish, no meat.' },
    'src-rc-0601': { agent: 'research', role: 'You', method: 'Explicit capture', at: '2026-06-01 09:15', quote: 'If the train is under six hours I would rather take it than fly.' },
    'src-rc-0921': { agent: 'research', role: 'You', method: 'Explicit capture', at: '2026-09-21 22:10', quote: 'Planning Lisbon for the second week of March 2027.' },
    'src-rc-0402': { agent: 'research', role: 'You', method: 'Explicit capture', at: '2026-04-02 19:40', quote: 'I am studying European Portuguese, roughly B1. Correct me inline as we go, not in a summary at the end.' }
  },

  /*
   * Each revision names the sources it rests on and the judgment that turned them into the stated interpretation.
   * The last revision is current. Earlier revisions and their sources stay intact.
   */
  memories: [
    {
      id: 'mem-beta', topic: 'harbor', thread: 'harbor-schedule', kind: 'Deadline', origin: 'user_explicit', effective: '2026-11-14',
      revisions: [
        { rev: 1, at: '2026-09-12 10:14', statement: 'The Harbor Atlas public beta ships on 14 November 2026. The date is fixed.', sources: ['src-cx-0912'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Codex' } }
      ]
    },
    {
      id: 'mem-review', topic: 'harbor', thread: 'harbor-schedule', kind: 'Fact', origin: 'agent_reported', effective: null,
      revisions: [
        { rev: 1, at: '2026-09-15 16:02', statement: 'Harbor Atlas design review recurs every second Thursday at 15:00 CET.', sources: ['src-oc-0915'], judgment: { kind: 'report', label: 'Agent report', detail: 'Reported by OpenCode' } }
      ]
    },
    {
      id: 'mem-pgvector', topic: 'harbor', thread: 'harbor-decisions', kind: 'Decision', origin: 'user_explicit', effective: '2026-08-20',
      revisions: [
        { rev: 1, at: '2026-08-20 09:41', statement: 'Harbor Atlas keeps vectors in PostgreSQL with pgvector rather than a separate vector database.', sources: ['src-cx-0820'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Codex' } }
      ]
    },
    {
      id: 'mem-tides', topic: 'harbor', thread: 'harbor-decisions', kind: 'Decision', origin: 'user_confirmed', effective: '2026-09-04',
      revisions: [
        { rev: 1, at: '2026-08-03 21:24', statement: 'Harbor Atlas calls the harbour authority API live when a chart is opened.', sources: ['src-rc-0803'], judgment: { kind: 'extraction', label: 'Interpreted by worker', detail: 'Extraction model nvidia/Nemotron-3_5-Lightning' } },
        { rev: 2, at: '2026-09-04 08:30', statement: 'Tide data is imported nightly from published harmonic constants. Harbor Atlas makes no live API calls.', sources: ['src-pf-0904'], judgment: { kind: 'correction', label: 'Your correction', detail: 'Authoritative owner edit' } }
      ]
    },
    {
      id: 'mem-tiles', topic: 'harbor', thread: 'harbor-decisions', kind: 'Preference', origin: 'inferred', effective: null,
      revisions: [
        { rev: 1, at: '2026-08-26 15:01', statement: 'Prefers server-rendered map tiles over client WebGL so older phones stay usable.', sources: ['src-oc-0826'], judgment: { kind: 'extraction', label: 'Interpreted by worker', detail: 'Extraction model nvidia/Nemotron-3_5-Lightning' } }
      ]
    },
    {
      id: 'mem-ios', topic: 'harbor', thread: 'harbor-people', kind: 'Fact', origin: 'agent_reported', effective: '2026-09-10',
      revisions: [
        { rev: 1, at: '2026-09-10 11:20', statement: 'Mara Oyelaran owns the Harbor Atlas iOS build.', sources: ['src-oc-0910'], judgment: { kind: 'report', label: 'Agent report', detail: 'Reported by OpenCode' } }
      ]
    },
    {
      id: 'mem-cartographer', topic: 'harbor', thread: 'harbor-people', kind: 'Context', origin: 'assistant_proposed', effective: null,
      revisions: [
        { rev: 1, at: '2026-09-18 19:11', statement: 'Bring in a contract cartographer before beta to review chart styling.', sources: ['src-rc-0918'], judgment: { kind: 'extraction', label: 'Interpreted by worker', detail: 'Memory from an assistant' } }
      ]
    },
    {
      id: 'mem-paragraphs', topic: 'writing', thread: 'writing-style', kind: 'Preference', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-07-02 13:08', statement: 'Keep paragraphs short in anything written for Iris.', sources: ['src-cx-0702'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Codex' } }
      ]
    },
    {
      id: 'mem-british', topic: 'writing', thread: 'writing-style', kind: 'Preference', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-07-02 13:08', statement: 'Use British spelling.', sources: ['src-cx-0702'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Codex' } }
      ]
    },
    {
      id: 'mem-plainverbs', topic: 'writing', thread: 'writing-style', kind: 'Preference', origin: 'inferred', effective: null,
      revisions: [
        { rev: 1, at: '2026-07-22 17:52', statement: 'Prefers plain verbs over corporate phrasing such as "leverage" or "utilise".', sources: ['src-rc-0722'], judgment: { kind: 'extraction', label: 'Interpreted by worker', detail: 'Extraction model nvidia/Nemotron-3_5-Lightning' } }
      ]
    },
    {
      id: 'mem-commits', topic: 'writing', thread: 'writing-formats', kind: 'Preference', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-07-15 10:31', statement: 'Commit subjects use the imperative mood and stay under sixty characters.', sources: ['src-cx-0715'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Codex' } }
      ]
    },
    {
      id: 'mem-releasenotes', topic: 'writing', thread: 'writing-formats', kind: 'Preference', origin: 'user_confirmed', effective: '2026-08-02',
      revisions: [
        { rev: 1, at: '2026-08-01 15:18', statement: 'Release notes list internal refactors first.', sources: ['src-cx-0801'], judgment: { kind: 'extraction', label: 'Interpreted by worker', detail: 'Extraction model nvidia/Nemotron-3_5-Lightning' } },
        { rev: 2, at: '2026-08-02 09:05', statement: 'Release notes lead with what changed for users; internal work goes last, briefly.', sources: ['src-pf-0802'], judgment: { kind: 'correction', label: 'Your correction', detail: 'Authoritative owner edit' } }
      ]
    },
    {
      id: 'mem-pnpm', topic: 'practice', thread: 'practice-code', kind: 'Fact', origin: 'agent_reported', effective: null,
      revisions: [
        { rev: 1, at: '2026-07-28 12:00', statement: 'Projects use pnpm 11 on Node.js 24.', sources: ['src-oc-0728'], judgment: { kind: 'report', label: 'Agent report', detail: 'Reported by OpenCode' } }
      ]
    },
    {
      id: 'mem-testsfirst', topic: 'practice', thread: 'practice-code', kind: 'Preference', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-06-11 16:40', statement: 'Write a failing test before fixing a reported bug.', sources: ['src-oc-0611'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by OpenCode' } }
      ]
    },
    {
      id: 'mem-noorm', topic: 'practice', thread: 'practice-code', kind: 'Preference', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-06-19 11:22', statement: 'No ORMs; keep SQL readable in repository modules.', sources: ['src-cx-0619'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Codex' } }
      ]
    },
    {
      id: 'mem-morningreview', topic: 'practice', thread: 'practice-rhythm', kind: 'Habit', origin: 'inferred', effective: null,
      revisions: [
        { rev: 1, at: '2026-09-05 08:20', statement: 'Reviews open pull requests in the morning, before standup.', sources: ['src-oc-0905'], judgment: { kind: 'extraction', label: 'Interpreted by worker', detail: 'Extraction model nvidia/Nemotron-3_5-Lightning' } }
      ]
    },
    {
      id: 'mem-pickup', topic: 'home', thread: 'home-hours', kind: 'Constraint', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-09-01 12:47', statement: 'Unavailable Tuesdays and Thursdays, 15:30 to 16:30, for school collection. Do not book calls then.', sources: ['src-cx-0901'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Codex' } }
      ]
    },
    {
      id: 'mem-quiet', topic: 'home', thread: 'home-hours', kind: 'Constraint', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-06-20 20:58', statement: 'No reminders or messages after 21:00.', sources: ['src-rc-0620'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Research chat' } }
      ]
    },
    {
      id: 'mem-diet', topic: 'travel', thread: 'travel-all', kind: 'Preference', origin: 'user_confirmed', effective: '2026-05-12',
      revisions: [
        { rev: 1, at: '2026-05-10 13:36', statement: 'Vegetarian.', sources: ['src-rc-0510'], judgment: { kind: 'extraction', label: 'Interpreted by worker', detail: 'Extraction model nvidia/Nemotron-3_5-Lightning' } },
        { rev: 2, at: '2026-05-12 18:02', statement: 'Pescatarian: eats fish, no meat.', sources: ['src-pf-0512'], judgment: { kind: 'correction', label: 'Your correction', detail: 'Authoritative owner edit' } }
      ]
    },
    {
      id: 'mem-trains', topic: 'travel', thread: 'travel-all', kind: 'Preference', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-06-01 09:15', statement: 'Prefers the train over flying when the journey is under six hours.', sources: ['src-rc-0601'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Research chat' } }
      ]
    },
    {
      id: 'mem-lisbon', topic: 'travel', thread: 'travel-all', kind: 'Plan', origin: 'user_explicit', effective: '2027-03-08',
      revisions: [
        { rev: 1, at: '2026-09-21 22:10', statement: 'Planning a trip to Lisbon in the second week of March 2027.', sources: ['src-rc-0921'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Research chat' } }
      ]
    },
    {
      id: 'mem-ptlevel', topic: 'learning', thread: 'learning-all', kind: 'Fact', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-04-02 19:40', statement: 'Studying European Portuguese at roughly B1 level.', sources: ['src-rc-0402'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Research chat' } }
      ]
    },
    {
      id: 'mem-ptinline', topic: 'learning', thread: 'learning-all', kind: 'Preference', origin: 'user_explicit', effective: null,
      revisions: [
        { rev: 1, at: '2026-04-02 19:40', statement: 'Wants Portuguese mistakes corrected inline as they happen, not summarised at the end.', sources: ['src-rc-0402'], judgment: { kind: 'explicit', label: 'Recorded as stated', detail: 'Explicit capture by Research chat' } }
      ]
    }
  ],

  suggestedQuestions: [
    'When is the Harbor Atlas beta due?',
    'How should agents write for me?',
    'When should agents avoid booking calls?',
    'What memories came from assistants?',
    'What do you know about my salary?'
  ]
};
