import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

// Faceted capitals and stepped metalwork are carried over from the instrument-room study.
const STEM = 14;

function stem(x: number, { tl = 0, tr = 0, bl = 0, br = 0 } = {}) {
  const w = STEM;
  const p: number[][] = [];
  if (tl) p.push([x - tl, 2.2], [x - tl, 0]); else p.push([x, 0]);
  if (tr) p.push([x + w + tr, 0], [x + w + tr, 2.2], [x + w, 10]); else p.push([x + w, 0]);
  if (br) p.push([x + w, 90], [x + w + br, 97.8], [x + w + br, 100]); else p.push([x + w, 100]);
  if (bl) p.push([x - bl, 100], [x - bl, 97.8], [x, 90]); else p.push([x, 100]);
  if (tl) p.push([x, 10]);
  return p;
}

const G: Record<string, { w: number; polys: number[][][]; evenodd?: number[] }> = {
  T: { w: 72, polys: [
    [[0, 0], [72, 0], [72, 16], [69.5, 16], [64, 6], [8, 6], [2.5, 16], [0, 16]],
    stem(29, { bl: 7, br: 7 })
  ] },
  H: { w: 76, polys: [
    stem(6, { tl: 6, tr: 6, bl: 6, br: 6 }),
    stem(56, { tl: 6, tr: 6, bl: 6, br: 6 }),
    [[20, 45], [56, 45], [56, 50.5], [20, 50.5]]
  ] },
  E: { w: 61, polys: [
    stem(6, { tl: 6, bl: 6 }),
    [[20, 0], [58, 0], [58, 17], [55.5, 17], [50, 5.5], [20, 5.5]],
    [[20, 47], [45, 47], [48, 42.5], [49.5, 42.5], [49.5, 57.5], [48, 57.5], [45, 52.5], [20, 52.5]],
    [[20, 94.5], [52, 94.5], [58.5, 81], [61, 81], [61, 100], [20, 100]]
  ] },
  A: { w: 86, polys: [
    [[34, 0], [48, 0], [80, 100], [64, 100]],
    [[35, 0], [40, 0], [10.5, 100], [5, 100]],
    [[0, 100], [19, 100], [19, 97.8], [13, 92], [7, 92], [0, 97.8]],
    [[56, 100], [86, 100], [86, 97.8], [78, 92], [61, 92], [56, 97.8]],
    [[20, 63], [54, 63], [55.5, 68.5], [18.5, 68.5]]
  ] },
  D: { w: 80, polys: [
    stem(6, { tl: 6, bl: 6 }),
    [[20, 0], [46, 0], [66, 8], [78, 28], [80, 50], [78, 72], [66, 92], [46, 100], [20, 100]],
    [[20, 5.5], [44, 5.5], [56, 13], [63, 30], [64.5, 50], [63, 70], [56, 87], [44, 94.5], [20, 94.5]]
  ], evenodd: [1, 2] },
  P: { w: 66, polys: [
    stem(6, { tl: 6, bl: 6, br: 6 }),
    [[20, 0], [44, 0], [58, 5], [65, 15], [65, 40], [58, 50], [44, 55], [20, 55]],
    [[20, 5.5], [42, 5.5], [48, 9], [51, 17], [51, 38], [48, 46], [42, 49.5], [20, 49.5]]
  ], evenodd: [1, 2] },
  R: { w: 80, polys: [
    stem(6, { tl: 6, bl: 6, br: 6 }),
    [[20, 0], [44, 0], [58, 5], [65, 15], [65, 38], [58, 48], [44, 53.5], [20, 53.5]],
    [[20, 5.5], [42, 5.5], [48, 9], [51, 17], [51, 36], [48, 44], [42, 48], [20, 48]],
    [[33, 50], [47, 50], [74, 93], [80, 97.8], [80, 100], [62, 100], [62, 97.8], [65, 95]]
  ], evenodd: [1, 2] },
  K: { w: 82, polys: [
    stem(6, { tl: 6, tr: 6, bl: 6, br: 6 }),
    [[20, 53], [62, 0], [68, 0], [20, 60.5]],
    [[54, 0], [76, 0], [76, 2.2], [69, 6], [57, 6], [54, 2.2]],
    [[28, 44], [41, 38], [74, 92], [82, 97.8], [82, 100], [60, 100], [60, 97.8], [64, 95]]
  ] }
};

function glyphPaths(word: string, tracking = 22) {
  let x = 0;
  const solid: string[] = [];
  const bowls: string[] = [];
  const ring = (points: number[][]) => `M${points.map(([px, y]) => `${(px + x).toFixed(2)} ${y}`).join("L")}Z`;
  for (const letter of word) {
    const glyph = G[letter];
    if (!glyph) { x += 40; continue; }
    glyph.polys.forEach((polygon, index) => {
      if (!glyph.evenodd?.includes(index)) solid.push(ring(polygon));
    });
    if (glyph.evenodd) bowls.push(glyph.evenodd.map(index => ring(glyph.polys[index])).join(""));
    x += glyph.w + tracking;
  }
  return { solid: solid.join(""), bowls, width: x - tracking };
}

const wordmark = glyphPaths("THREADKEEPER");
const monogram = glyphPaths("T", 0);
const guilloche = Array.from({ length: 22 }, (_, line) => {
  const phase = line / 22 * Math.PI * 2;
  return Array.from({ length: 151 }, (_, point) => {
    const x = point * 6;
    const t = x / 900;
    const y = 60 + Math.sin(t * Math.PI * 9 + phase) * 38.4 * Math.sin(t * Math.PI + 0.15) + Math.sin(t * Math.PI * 27 - phase) * 3;
    return `${point ? "L" : "M"}${x} ${y.toFixed(1)}`;
  }).join("");
});

export function Wordmark() {
  const gradient = `inscription-${useId()}`;
  return <>
    <svg className="guilloche-field" viewBox="0 0 900 120" preserveAspectRatio="none" aria-hidden="true">
      <g fill="none" stroke="#bca477" strokeWidth=".6">{guilloche.map((path, index) => <path key={index} d={path} />)}</g>
    </svg>
    <svg className="inscription" role="img" aria-label="Threadkeeper" viewBox={`-4 -4 ${wordmark.width + 8} 108`} height="40" style={{ aspectRatio: (wordmark.width + 8) / 108 }}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#f1e6c4" /><stop offset=".28" stopColor="#cdb68a" />
        <stop offset=".52" stopColor="#8f7a52" /><stop offset=".7" stopColor="#c8b183" /><stop offset="1" stopColor="#76633f" />
      </linearGradient></defs>
      {[["rgba(0,0,0,.85)", -2.2], ["rgba(223,218,206,.22)", 2.2], [`url(#${gradient})`, 0]].map(([fill, offset], index) => <g key={index} transform={`translate(0 ${offset})`} fill={String(fill)}>
        <path d={wordmark.solid} />{wordmark.bowls.map((path, bowl) => <path key={bowl} d={path} fillRule="evenodd" />)}
      </g>)}
    </svg>
  </>;
}

type SealTone = "electrum" | "oxblood";
type SealCentre = "monogram" | "check" | "forget" | "pending";

export function Seal({ size = 64, tone = "electrum", centre = "monogram", label, command = false }: {
  size?: number; tone?: SealTone; centre?: SealCentre; label?: string; command?: boolean;
}) {
  const id = `seal-${useId()}`;
  const metal = tone === "oxblood" ? "#c99a9f" : "#bca477";
  const dim = tone === "oxblood" ? "rgba(201,154,159,.55)" : "rgba(188,164,119,.55)";
  return <svg className="seal" viewBox="0 0 100 100" width={size} height={size} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <defs>
      <radialGradient id={`${id}-field`} cx=".42" cy=".36" r=".75"><stop offset="0" stopColor="#2b2c2e" /><stop offset=".7" stopColor="#151617" /><stop offset="1" stopColor="#0b0b0c" /></radialGradient>
      <path id={`${id}-text`} d="M50 50 m-33.5 0 a33.5 33.5 0 1 1 67 0 a33.5 33.5 0 1 1 -67 0" />
    </defs>
    <circle cx="50" cy="50" r="48.5" fill={`url(#${id}-field)`} stroke={metal} strokeWidth=".9" />
    <circle cx="50" cy="50" r="44.5" fill="none" stroke={metal} strokeWidth="1.6" />
    <circle cx="50" cy="50" r="42.2" fill="none" stroke={metal} strokeWidth=".6" />
    <text fontSize="7.4" letterSpacing="1.35" fill={dim}><textPath href={`#${id}-text`}>{command ? "THREADKEEPER · COMMAND · THREADKEEPER · " : "THREADKEEPER · PERSONAL CONTEXT · "}</textPath></text>
    <circle cx="50" cy="50" r="25.5" fill="none" stroke={metal} strokeWidth=".6" />
    <circle cx="50" cy="50" r="23.5" fill="#0d0e0f" stroke={dim} strokeWidth=".4" />
    <g className="seal-centre">
      {centre === "check" ? <path d="M38 50.5 L46.5 59 L63 41" fill="none" stroke={metal} strokeWidth="4.2" strokeLinecap="square" strokeLinejoin="miter" />
        : centre === "forget" ? <path d="M41 41 L59 59 M59 41 L41 59" stroke={metal} strokeWidth="4" strokeLinecap="square" />
          : centre === "pending" ? <g className="seal-pending"><path d="M50 37 L63 50 L50 63 L37 50 Z" fill="none" stroke={metal} strokeWidth="2.2" /><path d="M50 44 L56 50 L50 56 L44 50 Z" fill={metal} /></g>
            : <g transform="translate(42.08 39) scale(.22)" fill={metal}><path d={monogram.solid} /></g>}
    </g>
  </svg>;
}

export function Enclosure({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`enclosure ${className}`}><div className="enc-electrum"><div className="enc-iron"><div className="enc-rail"><div className="enc-well">{children}</div></div></div></div></div>;
}

export function CommandButton({ label, state, tone = "electrum", centre = "monogram", pending = false, done = false, className = "", disabled, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string; state?: string; tone?: SealTone; centre?: SealCentre; pending?: boolean; done?: boolean;
}) {
  return <button {...props} className={`cmd ${className}`} type={type} disabled={disabled || pending} aria-busy={pending || undefined} data-tone={tone} data-state={pending ? "pending" : done ? "done" : "idle"}>
    <span className="cmd-housing">
      <span className="cmd-socket"><span className="cmd-disc"><Seal size={52} centre={pending ? "pending" : done ? "check" : centre} tone={tone} command /></span></span>
      <span className="cmd-text"><span className="cmd-label">{label}</span>{state && <span className="cmd-state">{state}</span>}</span>
      <span className="cmd-terminal" aria-hidden="true"><span /></span>
    </span>
  </button>;
}

const dialAngle = (index: number, count: number) => count <= 1 ? 0 : -66 + 132 * index / (count - 1);

export function SubjectDial({ subjects, selected, onSelect }: { subjects: string[]; selected: string; onSelect: (subject: string) => void }) {
  const positions = ["", ...new Set(subjects.filter(Boolean))];
  const selectedIndex = Math.max(0, positions.indexOf(selected));
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const index = Math.min(previewIndex ?? selectedIndex, positions.length - 1);
  const group = useRef<HTMLDivElement>(null);
  const carriage = useRef<HTMLSpanElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const drag = useRef<{ start: number; index: number; x: number; y: number; moved: boolean } | null>(null);
  const height = Math.max(160, 60 + 40 * (positions.length - 1));
  const centreY = height / 2;
  const top = (height - 40 * (positions.length - 1)) / 2;

  useEffect(() => {
    const rail = group.current;
    const marker = carriage.current;
    const active = buttons.current[selectedIndex];
    if (!rail || !marker || !active) return;
    const measure = () => {
      marker.style.setProperty("--x", `${active.offsetLeft}px`);
      marker.style.setProperty("--w", `${active.offsetWidth}px`);
      rail.style.removeProperty("--track");
      rail.style.setProperty("--track", `${rail.scrollWidth}px`);
    };
    measure();
    if (rail.scrollWidth > rail.clientWidth) rail.scrollTo({ left: active.offsetLeft - rail.clientWidth / 2 + active.offsetWidth / 2, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    observer.observe(active);
    return () => observer.disconnect();
  }, [selectedIndex, subjects]);

  const select = (next: number, focus = false) => {
    onSelect(positions[next]);
    if (focus) buttons.current[next]?.focus();
  };
  const keyboard = (event: KeyboardEvent<HTMLElement>, current: number, radio: boolean) => {
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = positions.length - 1;
    else if (["ArrowDown", "ArrowRight"].includes(event.key)) next = current + 1;
    else if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = current - 1;
    else return;
    event.preventDefault();
    next = radio ? (next + positions.length) % positions.length : Math.max(0, Math.min(positions.length - 1, next));
    select(next, radio);
  };
  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    if (!gesture) return;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6) gesture.moved = true;
    if (!gesture.moved) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const angle = Math.atan2(event.clientY - bounds.top - bounds.height / 2, event.clientX - bounds.left - bounds.width / 2) * 180 / Math.PI;
    let closest = 0;
    for (let candidate = 1; candidate < positions.length; candidate++) {
      if (Math.abs(dialAngle(candidate, positions.length) - angle) < Math.abs(dialAngle(closest, positions.length) - angle)) closest = candidate;
    }
    gesture.index = closest;
    setPreviewIndex(closest);
  };
  const cancelPointer = () => { drag.current = null; setPreviewIndex(null); };

  return <Enclosure className="enclosure-wing subject-enclosure">
    <div className="wing-plate"><h2 className="plate-title">Subjects</h2><p className="plate-note">Turn the selector, or choose a name, to open what Threadkeeper holds on that subject.</p></div>
    <div className={`dial${previewIndex !== null ? " turning" : ""}`} style={{ "--dial-h": `${height}px`, "--dial-top": `${top}px` } as CSSProperties}>
      <svg className="dial-legend" viewBox={`0 0 320 ${height}`} width="320" height={height} aria-hidden="true">
        <g className="dial-minor">{Array.from({ length: 49 }, (_, tick) => {
          const angle = (-72 + tick * 3) * Math.PI / 180;
          const radius = 40 + (tick % 4 === 0 ? 10 : 8);
          return <line key={tick} x1={52 + 46 * Math.cos(angle)} y1={centreY + 46 * Math.sin(angle)} x2={52 + radius * Math.cos(angle)} y2={centreY + radius * Math.sin(angle)} />;
        })}</g>
        {positions.map((subject, item) => {
          const angle = dialAngle(item, positions.length) * Math.PI / 180;
          const x = 52 + 55 * Math.cos(angle), y = centreY + 55 * Math.sin(angle);
          return <g key={subject} className={`dial-tick${item === index ? " on" : ""}`}><line x1={52 + 49 * Math.cos(angle)} y1={centreY + 49 * Math.sin(angle)} x2={x} y2={y} /><polyline points={`${x},${y} 112,${top + 40 * item} 121,${top + 40 * item}`} /></g>;
        })}
      </svg>
      <div className={`knob${previewIndex !== null ? " gripped" : ""}`} role="slider" tabIndex={positions.length > 1 ? 0 : -1} aria-disabled={positions.length <= 1 || undefined} aria-label="Subject selector" aria-valuemin={0} aria-valuemax={positions.length - 1} aria-valuenow={index} aria-valuetext={positions[index] || "Overview"} style={{ left: 12, top: centreY - 40, width: 80, height: 80 }}
        onKeyDown={event => keyboard(event, selectedIndex, false)}
        onPointerDown={event => {
          if (!event.isPrimary || event.button !== 0 || positions.length <= 1) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { start: selectedIndex, index: selectedIndex, x: event.clientX, y: event.clientY, moved: false };
          setPreviewIndex(selectedIndex);
        }}
        onPointerMove={movePointer}
        onPointerUp={() => {
          const gesture = drag.current;
          if (!gesture) return;
          select(gesture.moved ? gesture.index : (gesture.start + 1) % positions.length);
          cancelPointer();
        }}
        onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}>
        <div className="knob-knurl"><div className="knob-cap"><div className="knob-face" style={{ "--angle": `${dialAngle(index, positions.length)}deg` } as CSSProperties}><span className="knob-index" /><span className="knob-boss" /></div></div></div>
      </div>
      <div className="dial-positions" role="radiogroup" aria-label="Subject" ref={group}>
        {positions.map((subject, item) => <button key={subject} type="button" role="radio" className="dial-pos" aria-checked={item === selectedIndex} tabIndex={item === selectedIndex ? 0 : -1} style={{ "--row": item } as CSSProperties} title={subject || "Overview"} ref={element => { buttons.current[item] = element; }} onClick={() => select(item)} onKeyDown={event => keyboard(event, item, true)}><span className="mark mark-diamond" aria-hidden="true" /><span className="dial-name">{subject || "Overview"}</span></button>)}
        <span className="dial-carriage" aria-hidden="true" ref={carriage} />
      </div>
    </div>
  </Enclosure>;
}
