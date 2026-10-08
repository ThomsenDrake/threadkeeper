/*
 * House inscription and seals.
 * Capitals are drawn on a 100-unit cap height: thick stems (14), thin hairlines (5.5),
 * flared terminals cut at an angle, and bowls built from straight facets instead of curves.
 */
(function () {
  const STEM = 14;

  function stem(x, { tl = 0, tr = 0, bl = 0, br = 0 } = {}) {
    const w = STEM;
    const p = [];
    if (tl) p.push([x - tl, 2.2], [x - tl, 0]); else p.push([x, 0]);
    if (tr) p.push([x + w + tr, 0], [x + w + tr, 2.2], [x + w, 10]); else p.push([x + w, 0]);
    if (br) p.push([x + w, 90], [x + w + br, 97.8], [x + w + br, 100]); else p.push([x + w, 100]);
    if (bl) p.push([x - bl, 100], [x - bl, 97.8], [x, 90]); else p.push([x, 100]);
    if (tl) p.push([x, 10]);
    return p;
  }

  const G = {
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

  const ring = (pts, dx) => 'M' + pts.map(([x, y]) => `${(x + dx).toFixed(2)} ${y}`).join('L') + 'Z';

  function glyphPaths(word, tracking) {
    let x = 0;
    const solid = [];
    const holes = [];
    for (const ch of word) {
      const g = G[ch];
      if (!g) { x += 40; continue; }
      g.polys.forEach((poly, i) => {
        if (g.evenodd && g.evenodd.includes(i)) holes.push({ d: ring(poly, x), outer: i === g.evenodd[0] });
        else solid.push(ring(poly, x));
      });
      x += g.w + tracking;
    }
    const bowls = [];
    for (let i = 0; i < holes.length; i += 2) bowls.push(holes[i].d + holes[i + 1].d);
    return { solid: solid.join(''), bowls, width: x - tracking };
  }

  let uid = 0;

  /* Inlaid inscription: a dark cut wall above, a lit lip below, polished electrum fill. */
  function inscription(word, { height = 36, tracking = 22, label } = {}) {
    const id = 'ins' + (++uid);
    const { solid, bowls, width } = glyphPaths(word, tracking);
    const pad = 4;
    const shapes = (fill, dy) =>
      `<g transform="translate(0 ${dy})" fill="${fill}"><path d="${solid}"/>${bowls.map((d) => `<path fill-rule="evenodd" d="${d}"/>`).join('')}</g>`;
    return `<svg class="inscription" role="img" aria-label="${label || word}" viewBox="${-pad} ${-pad} ${width + pad * 2} ${100 + pad * 2}" height="${height}" style="aspect-ratio:${(width + pad * 2) / (100 + pad * 2)}">
      <defs>
        <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f1e6c4"/><stop offset=".28" stop-color="#cdb68a"/>
          <stop offset=".52" stop-color="#8f7a52"/><stop offset=".7" stop-color="#c8b183"/>
          <stop offset="1" stop-color="#76633f"/>
        </linearGradient>
      </defs>
      ${shapes('rgba(0,0,0,.85)', -2.2)}
      ${shapes('rgba(223,218,206,.22)', 2.2)}
      ${shapes(`url(#${id}g)`, 0)}
    </svg>`;
  }

  function monogram(letter, cx, cy, h, fill) {
    const g = G[letter];
    const s = h / 100;
    const { solid, bowls } = glyphPaths(letter, 0);
    return `<g transform="translate(${cx - (g.w * s) / 2} ${cy - h / 2}) scale(${s})" fill="${fill}"><path d="${solid}"/>${bowls.map((d) => `<path fill-rule="evenodd" d="${d}"/>`).join('')}</g>`;
  }

  /*
   * Authority seal: fine outer ring, double ring, ring inscription, inner ring, centre mark.
   * centre: 'monogram' | 'check' | 'forget' | 'pending'
   */
  function seal({ size = 64, centre = 'monogram', text = 'THREADKEEPER \u00b7 PERSONAL CONTEXT \u00b7 ', tone = 'electrum', label } = {}) {
    const id = 'seal' + (++uid);
    const metal = tone === 'oxblood' ? '#c99a9f' : '#BCA477';
    const dim = tone === 'oxblood' ? 'rgba(201,154,159,.55)' : 'rgba(188,164,119,.55)';
    let mark;
    if (centre === 'check') {
      mark = `<path d="M38 50.5 L46.5 59 L63 41" fill="none" stroke="${metal}" stroke-width="4.2" stroke-linecap="square" stroke-linejoin="miter"/>`;
    } else if (centre === 'forget') {
      mark = `<path d="M41 41 L59 59 M59 41 L41 59" stroke="${metal}" stroke-width="4" stroke-linecap="square"/>`;
    } else if (centre === 'pending') {
      mark = `<g class="seal-pending"><path d="M50 37 L63 50 L50 63 L37 50 Z" fill="none" stroke="${metal}" stroke-width="2.2"/><path d="M50 44 L56 50 L50 56 L44 50 Z" fill="${metal}"/></g>`;
    } else {
      mark = monogram('T', 50, 50, 22, metal);
    }
    return `<svg class="seal" viewBox="0 0 100 100" width="${size}" height="${size}" ${label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"'}>
      <defs>
        <radialGradient id="${id}f" cx=".42" cy=".36" r=".75">
          <stop offset="0" stop-color="#2b2c2e"/><stop offset=".7" stop-color="#151617"/><stop offset="1" stop-color="#0b0b0c"/>
        </radialGradient>
        <path id="${id}t" d="M50 50 m-33.5 0 a33.5 33.5 0 1 1 67 0 a33.5 33.5 0 1 1 -67 0"/>
      </defs>
      <circle cx="50" cy="50" r="48.5" fill="url(#${id}f)" stroke="${metal}" stroke-width=".9"/>
      <circle cx="50" cy="50" r="44.5" fill="none" stroke="${metal}" stroke-width="1.6"/>
      <circle cx="50" cy="50" r="42.2" fill="none" stroke="${metal}" stroke-width=".6"/>
      <text font-size="7.4" letter-spacing="1.35" fill="${dim}" font-family="var(--face-engraved)"><textPath href="#${id}t" startOffset="0">${text}</textPath></text>
      <circle cx="50" cy="50" r="25.5" fill="none" stroke="${metal}" stroke-width=".6"/>
      <circle cx="50" cy="50" r="23.5" fill="#0d0e0f" stroke="${dim}" stroke-width=".4"/>
      <g class="seal-centre">${mark}</g>
    </svg>`;
  }

  /* Engine-turned field: interlaced sine bands, as on engraved instrument plates. */
  function guilloche({ width = 900, height = 120, lines = 22 } = {}) {
    const paths = [];
    for (let k = 0; k < lines; k++) {
      const phase = (k / lines) * Math.PI * 2;
      let d = '';
      for (let x = 0; x <= width; x += 6) {
        const t = x / width;
        const y = height / 2 + Math.sin(t * Math.PI * 9 + phase) * (height * 0.32) * Math.sin(t * Math.PI + 0.15) + Math.sin(t * Math.PI * 27 - phase) * 3;
        d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
      }
      paths.push(`<path d="${d}"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><g fill="none" stroke="#BCA477" stroke-width=".6">${paths.join('')}</g></svg>`;
  }

  window.TK_GLYPHS = { inscription, seal, guilloche };
})();
