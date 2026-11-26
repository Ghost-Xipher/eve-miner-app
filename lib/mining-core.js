// EVE Miner's calculations, with no page or network code so they can be tested in Node.
// In the page it is loaded with a plain <script> and sets window.MINER_CORE; in Node it is require()d.
(function (root) {
  "use strict";

  // ---------------- fees ----------------
  // Sales tax 7.5% minus 11% of it per Accounting level; broker fee 3% minus 0.3% per Broker Relations level
  // (standings not counted, so it is the most you would pay). Same constants as EVE Hub Trader.
  const taxFor = lv => 0.075 * (1 - 0.11 * lv);
  const brokerFor = lv => 0.03 - 0.003 * lv;

  // ---------------- reprocessing ----------------
  // Yield = base x (1 + 3% x Reprocessing) x (1 + 2% x Reprocessing Efficiency) x (1 + 2% x the ore's processing skill)
  // x (1 + implant %). The base is the station's (50% at most NPC stations) or a structure's with its rigs.
  function refineYield(base, rep, eff, ore, implant) {
    return base * (1 + 0.03 * rep) * (1 + 0.02 * eff) * (1 + 0.02 * ore) * (1 + (implant || 0) / 100);
  }
  // Minerals from one unit of ore (fractional; the game rounds down per batch) at a given yield.
  const mineralsPerUnit = (ore, y) => ore.m.map(([id, q]) => [id, q * y / ore.ps]);

  // ---------------- dogma (mining subset) ----------------
  // A small version of EVE's attribute engine, driven entirely by the SDE data in assets/mining.js: the ship's own
  // effects (hull bonuses), every skill at its level, each module and its loaded crystal, and drones. Values are worked
  // out lazily with EVE's operator order and the stacking penalty for non-stackable attributes changed by modules.
  const OPS = [-1, 0, 1, 2, 3, 4, 5, 6, 7];
  const REQ = [182, 183, 184, 1285, 1289, 1290];
  const PEN = i => Math.exp(-((i / 2.67) ** 2));

  function fitStats(D, state) {
    const items = [];
    const mk = (id, kind, extra) => { const t = D.types[id]; if (!t) return null; const it = { id, kind, t, base: Object.assign({}, t.a), ...extra }; items.push(it); return it; };
    const ship = state.ship ? mk(state.ship, "ship") : { id: 0, kind: "ship", t: { a: {}, e: [] }, base: {} };
    if (!state.ship) items.push(ship);
    const char = { id: -1, kind: "char", t: { a: {}, e: [] }, base: {} }; items.push(char);
    const levels = state.skills || {};
    for (const id of D.fit.skills) { const s = mk(id, "skill"); s.base[280] = levels[id] || 0; }
    const mods = (state.mods || []).map((m, i) => {
      const it = m && mk(m.id, "mod", { slot: i, on: m.on !== false }); if (!it) return null;
      if (m.charge && D.types[m.charge]) { it.charge = mk(m.charge, "charge", { mod: it }); }
      return it;
    });
    const drones = (state.drones || []).filter(d => d && D.types[d.id] && d.n > 0).map(d => mk(d.id, "drone", { n: d.n }));
    const fitted = items.filter(x => x.kind === "mod" || x.kind === "charge");
    const owned = items.filter(x => x.kind === "mod" || x.kind === "charge" || x.kind === "drone");
    const needs = (it, sk) => REQ.some(k => it.base[k] === sk);

    // Collect every modifier with its targets.
    const mods2 = new Map(); // item -> attr -> [{op, src, attr, pen}]
    const add = (tgt, attr, m) => { if (!tgt) return; let a = mods2.get(tgt); if (!a) mods2.set(tgt, a = new Map()); if (!a.has(attr)) a.set(attr, []); a.get(attr).push(m); };
    const domainItem = (src, dom) => dom === "shipID" ? ship : dom === "charID" ? char : dom === "itemID" ? src : dom === "otherID" ? (src.kind === "mod" ? src.charge : src.kind === "charge" ? src.mod : null) : null;
    for (const src of items) {
      if (src.kind === "char") continue; // untrained skills (level 0) still apply: their bonus x 0 is nothing
      for (const e of src.t.e) {
        const E = D.effects[e]; if (!E) continue;
        const cat = E[1];
        const live = cat === 0 || cat === 4 || (cat === 1 && src.on !== false && src.kind === "mod");
        if (!live) continue;
        for (const [func, dom, mattr, battr, op, grp, sk] of E[2]) {
          if (op === 9 || !OPS.includes(op)) continue;
          const pen = (src.kind === "mod" || src.kind === "charge" || src.kind === "drone");
          const m = { op, src, attr: battr, pen };
          if (func === "ItemModifier") add(domainItem(src, dom), mattr, m);
          else if (func === "LocationModifier") { for (const t of fitted) add(t, mattr, m); }
          else if (func === "LocationGroupModifier") { for (const t of fitted) if (t.t.g === grp) add(t, mattr, m); }
          else if (func === "LocationRequiredSkillModifier") { for (const t of (dom === "charID" ? owned : fitted)) if (needs(t, sk)) add(t, mattr, m); }
          else if (func === "OwnerRequiredSkillModifier") { for (const t of owned) if (needs(t, sk)) add(t, mattr, m); }
        }
      }
    }
    const memo = new Map(), busy = new Map();
    function get(it, attr) {
      if (!it) return 0;
      let mm = memo.get(it); if (!mm) memo.set(it, mm = new Map());
      if (mm.has(attr)) return mm.get(attr);
      const baseV = it.base[attr] ?? ((D.attrs[attr] || [])[2] || 0);
      let bz = busy.get(it); if (!bz) busy.set(it, bz = new Set());
      if (bz.has(attr)) return baseV; // a loop in the data: use the unmodified value
      bz.add(attr);
      let v = baseV;
      const list = (mods2.get(it) || new Map()).get(attr) || [];
      const stack = (D.attrs[attr] || [0, 1])[1] === 1;
      for (const op of OPS) {
        const ms = list.filter(m => m.op === op); if (!ms.length) continue;
        const vals = ms.map(m => ({ x: get(m.src, m.attr), pen: m.pen && !stack }));
        if (op === -1 || op === 7) { v = vals[vals.length - 1].x; continue; }
        if (op === 2) { for (const o of vals) v += o.x; continue; }
        if (op === 3) { for (const o of vals) v -= o.x; continue; }
        const mul = o => op === 6 ? 1 + o.x / 100 : (op === 1 || op === 5) ? (o.x ? 1 / o.x : 1) : o.x;
        const free = vals.filter(o => !o.pen).map(mul), pens = vals.filter(o => o.pen).map(mul);
        for (const f of free) v *= f;
        const up = pens.filter(f => f > 1).sort((a, b) => b - a), dn = pens.filter(f => f < 1).sort((a, b) => a - b);
        up.forEach((f, i) => { v *= 1 + (f - 1) * PEN(i); });
        dn.forEach((f, i) => { v *= 1 + (f - 1) * PEN(i); });
      }
      bz.delete(attr);
      mm.set(attr, v);
      return v;
    }
    return { get, ship, char, mods, drones };
  }

  // What a mining module, crystal or drone yields: m³ per cycle, cycle time, crit chance and bonus, waste.
  // "rate" is m³ per second including the expected crit bonus (chance x extra yield).
  function minerOut(F, it) {
    const amt = F.get(it, 77), dur = F.get(it, 73) / 1000, cc = F.get(it, 5967), cb = F.get(it, 5969);
    const wp = F.get(it, 3154), wm = F.get(it, 3153), n = it.n || 1;
    if (!(amt > 0 && dur > 0)) return null;
    return { amt, dur, crit: cc, critBonus: cb, wasteChance: wp, wasteMult: wm, n, rate: n * amt * (1 + cc * cb) / dur, rateBase: n * amt / dur, range: F.get(it, 54) };
  }

  // Which ores a module can mine: ice harvesters need Ice Harvesting (16281), everything else mines asteroids;
  // Mercoxit needs a Deep Core module (Deep Core Mining 11395). Crystals boost only the ores on their type list.
  const isIceTool = it => REQ.some(k => it.base[k] === 16281 || it.base[k] === 43702);
  const isDeepCore = it => REQ.some(k => it.base[k] === 11395);
  function canMine(it, ore) {
    if (ore.k === "ice") return isIceTool(it);
    if (isIceTool(it)) return false;
    if (ore.k === "merc") return isDeepCore(it);
    return true;
  }

  // ---------------- fitting rules ----------------
  const REQ_LV = [277, 278, 279, 1286, 1287, 1288];
  const hasEff = (D, id, name) => ((D.types[id] || {}).e || []).some(e => (D.effects[e] || [])[0] === name);
  const slotOf = (D, id) => hasEff(D, id, "hiPower") ? "hi" : hasEff(D, id, "medPower") ? "mid" : hasEff(D, id, "loPower") ? "lo" : hasEff(D, id, "rigSlot") ? "rig" : null;
  // canFitShipGroup restrictions and rig size.
  function fitsShip(D, ship, mid) {
    const a = (D.types[mid] || {}).a || {}, sa = (D.types[ship] || {}).a || {}, sg = (D.types[ship] || {}).g;
    const groups = [1298, 1299, 1300, 1301].map(k => a[k]).filter(Boolean);
    if (groups.length && !groups.includes(sg)) return false;
    if (slotOf(D, mid) === "rig" && a[1547] && sa[1547] && a[1547] !== sa[1547]) return false;
    return true;
  }
  // A crystal fits a module that takes its charge group (and size).
  function crystalFits(D, mod, ch) {
    const a = (D.types[mod] || {}).a || {}, c = D.types[ch]; if (!c) return false;
    return [604, 605, 606, 609, 610].some(k => a[k] && a[k] === c.g) && (!a[128] || !(c.a || {})[128] || a[128] === c.a[128]);
  }
  const crystalOres = (D, ch) => new Set(D.typeLists[((D.types[ch] || {}).a || {})[3148]] || []);
  // Every required skill at its level; lvOf(skill id) -> trained level.
  function reqsMet(D, id, lvOf) {
    const a = (D.types[id] || {}).a || {};
    return REQ.every((k, i) => !a[k] || lvOf(a[k]) >= (a[REQ_LV[i]] || 1));
  }
  // The skills a type needs, with their own prerequisites where the data has them: {skill id: level}.
  function reqsOf(D, id, out = {}, seen = new Set()) {
    if (seen.has(id)) return out; seen.add(id);
    const a = (D.types[id] || {}).a || {};
    REQ.forEach((k, i) => { const s = a[k]; if (!s) return; out[s] = Math.max(out[s] || 0, a[REQ_LV[i]] || 1); reqsOf(D, s, out, seen); });
    return out;
  }
  // CPU, powergrid, calibration and turret use of a fitStats result, against the ship's (after skills).
  function fitUse(D, F) {
    const fitted = F.mods.filter(Boolean), sum = attr => fitted.reduce((s, m) => s + F.get(m, attr), 0);
    const u = { cpu: sum(50), cpuMax: F.get(F.ship, 48), pg: sum(30), pgMax: F.get(F.ship, 11), cal: sum(1153), calMax: F.get(F.ship, 1132),
      turrets: fitted.filter(m => hasEff(D, m.id, "turretFitted")).length, turretMax: (F.ship.base || {})[102] || 0 };
    u.ok = u.cpu <= u.cpuMax + 1e-6 && u.pg <= u.pgMax + 1e-6 && u.cal <= u.calMax + 1e-6 && u.turrets <= u.turretMax;
    return u;
  }

  // ---------------- best fit ----------------
  // Searches the fits a pilot can fly for the most m³ per second on one ore (expected crits included; waste is ore
  // lost from the rock, not from the hold, so it only breaks ties). The hull's own required skills are assumed.
  // opt: { ship, ore (an ore from D.ores), lvOf (skill id -> level), meta: allowed meta groups (default Tech I/II),
  //        on (modules active, default true) }.
  // Steps: every mining module that can mine the ore, as many as the high slots (and turret points) take, with each
  // crystal that fits it and boosts that ore; the best few are then filled greedily with drones, low-slot, rig and
  // mid-slot modules that add yield, and each filled slot is tried with every other choice once more.
  // -> { fit: {ship, hi:[{id, charge}], mid:[{id}], lo, rig, drone, droneN}, rate (m³/s), use } or null.
  function bestFit(D, opt) {
    const ship = opt.ship, ore = opt.ore, lvOf = opt.lvOf, T = id => D.types[id] || {};
    const meta = new Set(opt.meta || [0, 1, 2]), sa = k => (T(ship).a || {})[k] || 0;
    const n = { hi: sa(14), mid: sa(13), lo: sa(12), rig: sa(1137) };
    const skills = {}; for (const s of D.fit.skills) skills[s] = lvOf(s);
    const ok = id => meta.has(T(id).m || 0) && reqsMet(D, id, lvOf);
    const cand = s => D.fit.mods.filter(id => slotOf(D, id) === s && fitsShip(D, ship, id) && ok(id));
    const maxGrp = id => { const a = T(id).a || {}; return a[1544] || a[763] || 0; };
    const st = { hi: [], mid: [], lo: [], rig: [], drone: 0, droneN: 0 };
    const mods = s => [...s.hi.map(x => ({ id: x.id, charge: x.charge })), ...s.mid, ...s.lo, ...s.rig].map(m => ({ ...m, on: opt.on !== false }));
    function score(s) {
      const F = fitStats(D, { ship, mods: mods(s), skills, drones: s.drone && s.droneN ? [{ id: s.drone, n: s.droneN }] : [] });
      const use = fitUse(D, F); if (!use.ok) return null;
      let rate = 0, waste = 0;
      for (const it of [...F.mods, ...F.drones]) {
        if (!it || !canMine(it, ore)) continue;
        const o = minerOut(F, it); if (!o) continue;
        rate += o.rate; waste += o.rate * (o.wasteChance || 0) / 100 * (o.wasteMult || 0);
      }
      return { rate, waste, use };
    }
    const better = (a, b) => a && (!b || a.rate > b.rate + 1e-9 || (Math.abs(a.rate - b.rate) <= 1e-9 && a.waste < b.waste - 1e-9));
    const copy = s => ({ hi: s.hi.map(x => ({ ...x })), mid: [...s.mid], lo: [...s.lo], rig: [...s.rig], drone: s.drone, droneN: s.droneN });
    const grpCount = (s, g) => [...s.mid, ...s.lo, ...s.rig].filter(m => T(m.id).g === g).length;

    // 1. High slots: one kind of mining module (with a crystal for this ore, or none) in as many slots as fit.
    const tops = [];
    for (const id of cand("hi")) {
      const probe = fitStats(D, { ship, mods: [{ id }], skills });
      if (!probe.mods[0] || !minerOut(probe, probe.mods[0]) || !canMine(probe.mods[0], ore)) continue;
      const crystals = [0, ...D.fit.crystals.filter(c => crystalFits(D, id, c) && ok(c) && crystalOres(D, c).has(ore.id))];
      const turret = hasEff(D, id, "turretFitted");
      for (const charge of crystals) {
        for (let k = turret ? Math.min(n.hi, sa(102)) : n.hi; k >= 1; k--) {
          const s = { ...copy(st), hi: Array.from({ length: k }, () => ({ id, charge })) };
          const r = score(s); if (r) { tops.push({ s, r }); break; }
        }
      }
    }
    tops.sort((a, b) => better(a.r, b.r) ? -1 : better(b.r, a.r) ? 1 : 0);
    // Ships that mine with drones only (Porpoise, Orca, Rorqual) start from empty high slots.
    if (tops.length < 3) { const r0 = score(st); if (r0) tops.push({ s: copy(st), r: r0 }); }
    // Drones (if the ore drones can mine it), then low, rig and mid slots, greedily; then one swap pass.
    const dCands = D.fit.drones.filter(ok);
    const order = [["lo", cand("lo")], ["rig", cand("rig")], ["mid", cand("mid")]];
    let best = null;
    for (const top of tops.slice(0, 3)) {
      let s = top.s, r = top.r;
      for (const d of dCands) {
        const nn = Math.min(5, Math.floor(sa(1271) / ((T(d).a || {})[1272] || 1e9)));
        if (nn < 1 || sa(283) <= 0) continue;
        const s2 = { ...copy(s), drone: d, droneN: nn }, r2 = score(s2);
        if (r2 && r2.rate > r.rate + 1e-9 && better(r2, r)) { s = s2; r = r2; }
      }
      for (const [slot, list] of order) {
        for (let i = 0; i < n[slot]; i++) {
          let pick = null;
          for (const id of list) {
            const g = maxGrp(id); if (g && grpCount(s, T(id).g) >= g) continue;
            const s2 = copy(s); s2[slot].push({ id }); const r2 = score(s2);
            if (r2 && r2.rate > r.rate + 1e-9 && better(r2, pick && pick.r)) pick = { s: s2, r: r2 };
          }
          if (!pick) break;
          s = pick.s; r = pick.r;
        }
      }
      for (const [slot, list] of order) for (let i = 0; i < s[slot].length; i++) for (const id of list) {
        if (id === s[slot][i].id) continue;
        const s2 = copy(s); s2[slot][i] = { id };
        const g = maxGrp(id); if (g && grpCount(s2, T(id).g) > g) continue;
        const r2 = score(s2); if (better(r2, r)) { s = s2; r = r2; }
      }
      if (better(r, best && best.r)) best = { s, r };
    }
    if (!best || !(best.r.rate > 0)) return null;
    const pad = (l, k) => { const o = l.slice(0, k); while (o.length < k) o.push(null); return o; };
    return { fit: { ship, hi: pad(best.s.hi, n.hi), mid: pad(best.s.mid, n.mid), lo: pad(best.s.lo, n.lo), rig: pad(best.s.rig, n.rig), drone: best.s.drone, droneN: best.s.droneN },
      rate: best.r.rate, use: best.r.use };
  }

  // Career-stage presets for the Yield Calculator: ships per stage and the skill level they assume (the hull's own
  // requirements are raised to what it needs). Each preset's fit comes from bestFit.
  const PRESET_STAGES = [
    { key: "new", name: "New pilot", lv: 1, ships: ["Venture"] },
    { key: "frig", name: "Mining frigates", lv: 4, ships: ["Venture", "Prospect", "Endurance"] },
    { key: "barge", name: "Mining barges", lv: 4, ships: ["Procurer", "Retriever", "Covetor"] },
    { key: "exh", name: "Exhumers", lv: 4, ships: ["Skiff", "Mackinaw", "Hulk"] },
    { key: "max", name: "Max skills", lv: 5, ships: ["Skiff", "Mackinaw", "Hulk", "Porpoise", "Orca", "Rorqual"] }
  ];
  // Skill levels for a stage and ship: every skill at lv, raised to what the hull needs. -> {skill id: level}
  function stageSkills(D, lv, ship) {
    const out = {}; for (const s of D.fit.skills) out[s] = lv;
    for (const [s, l] of Object.entries(reqsOf(D, ship))) if (s in out) out[s] = Math.max(out[s], l);
    return out;
  }

  // ---------------- market ----------------
  // Best prices at one station from a type's region orders, with how much is on offer within 5% of the best.
  function bookAt(orders, station) {
    let bid = 0, ask = Infinity;
    for (const o of orders) if (o.location_id === station) { if (o.is_buy_order) bid = Math.max(bid, o.price); else ask = Math.min(ask, o.price); }
    let bidVol = 0, askVol = 0;
    for (const o of orders) if (o.location_id === station) {
      if (o.is_buy_order && bid && o.price >= bid * 0.95) bidVol += o.volume_remain;
      if (!o.is_buy_order && ask < Infinity && o.price <= ask * 1.05) askVol += o.volume_remain;
    }
    return { bid, ask: ask < Infinity ? ask : 0, bidVol, askVol };
  }
  // What one unit sells for after fees: "instant" sells into the best buy order (sales tax), "list" places a sell
  // order just under the lowest one (sales tax and broker fee).
  function netPrice(book, mode, tax, broker) {
    if (!book) return 0;
    if (mode === "list") return book.ask ? book.ask * (1 - tax - broker) : 0;
    return book.bid * (1 - tax);
  }

  // ---------------- map ----------------
  // Jump counts over the bundled star map. pref "secure" weights entering a system under 0.45 like the in-game
  // "prefer safer" setting (a detour of any length is better), "shortest" counts plain jumps.
  function mapIndex(MAP) {
    if (MAP._ix) return MAP._ix;
    const ix = new Map(MAP.ids.map((id, i) => [id, i]));
    MAP._adj = MAP.adj.map(s => s ? s.split(",").map(Number) : []);
    return MAP._ix = ix;
  }
  const isHigh = (MAP, i) => MAP.sec[i] >= 450;
  function treeFrom(MAP, from, pref) {
    const ix = mapIndex(MAP), start = ix.get(from);
    const n = MAP.ids.length, cost = new Float64Array(n).fill(Infinity), hops = new Int32Array(n).fill(-1), prev = new Int32Array(n).fill(-1);
    if (start == null) return { cost, hops, prev, ix };
    const PEN = 10000;
    cost[start] = 0; hops[start] = 0;
    // Dial-style queue: costs are whole numbers (1 per jump, + PEN for unsafe), so a bucket queue keeps it fast.
    const buckets = new Map([[0, [start]]]); let cur = 0, left = 1;
    while (left > 0) {
      const b = buckets.get(cur);
      if (!b || !b.length) { buckets.delete(cur); cur = Math.min(...buckets.keys()); continue; }
      const i = b.pop(); left--;
      if (cost[i] !== cur) continue;
      for (const j of MAP._adj[i]) {
        const c = cur + 1 + (pref === "secure" && !isHigh(MAP, j) ? PEN : 0);
        if (c < cost[j]) {
          cost[j] = c; hops[j] = hops[i] + 1; prev[j] = i;
          if (!buckets.has(c)) buckets.set(c, []);
          buckets.get(c).push(j); left++;
        }
      }
    }
    return { cost, hops, prev, ix };
  }
  // Jumps from every system to the nearest system in a set (multi-source breadth-first search, plain jumps).
  function nearestOf(MAP, sources) {
    mapIndex(MAP);
    const n = MAP.ids.length, d = new Int32Array(n).fill(-1), q = [];
    for (const i of sources) { d[i] = 0; q.push(i); }
    for (let h = 0; h < q.length; h++) { const i = q[h]; for (const j of MAP._adj[i]) if (d[j] < 0) { d[j] = d[i] + 1; q.push(j); } }
    return d;
  }
  // The path (system indexes) from the tree's start to a system.
  function pathTo(tree, i) { const p = []; for (let x = i; x >= 0; x = tree.prev[x]) p.unshift(x); return p; }
  const secText = s => (s > 0 && s < 50 ? 0.1 : Math.round(s / 100) / 10).toFixed(1);
  const klass = s => s >= 450 ? "high" : s > 0 ? "low" : "null";

  // ---------------- where ores are found ----------------
  // Asteroid belt ores (belts only, not ore anomalies) since CCP's 2019 resource redistribution, from the EVE
  // University wiki "Asteroids and ore" (revision of 14 Nov 2026; the page itself says parts may need updating).
  // A guide, not a guarantee. Highsec and lowsec depend on the empire quarter (map "q": A, C, G, M) and the
  // displayed security; nullsec on the region's class and the true security (x1000 like the map).
  const BELT_ORES = ["Veldspar", "Scordite", "Pyroxeres", "Plagioclase", "Omber", "Kernite", "Jaspet", "Hemorphite", "Hedbergite",
    "Bistot", "Arkonor", "Mercoxit"];
  const LOW_ORES = { A: ["Pyroxeres", "Kernite", "Jaspet"], C: ["Kernite", "Pyroxeres"], G: ["Omber", "Jaspet"], M: ["Kernite", "Omber"] };
  const LOW_DEEP = { A: "Hemorphite", C: "Hedbergite", G: "Hemorphite", M: "Hedbergite" }; // added at 0.2 and 0.1
  const NULL_CLASS = {
    F: ["Detorid", "Cache", "Insmother", "Impass", "Feythabolis", "Tenerifis", "Omist"],
    G: ["Stain", "Esoteria", "Querious", "Paragon Soul", "Delve", "Period Basis"],
    H: ["Vale of the Silent", "Tribute", "Venal", "Geminate", "Deklein", "Tenal", "Branch"],
    I: ["Wicked Creek", "Scalding Pass", "Great Wildlands", "Curse", "Catch", "Immensea", "Providence"],
    J: ["Pure Blind", "Syndicate", "Fade", "Cloud Ring", "Outer Ring", "Fountain"],
    K: ["Cobalt Edge", "Perrigen Falls", "Malpais", "Oasa", "The Kalevala Expanse", "Outer Passage", "Etherium Reach", "The Spire"]
  };
  const REGION_CLASS = {}; for (const [c, l] of Object.entries(NULL_CLASS)) for (const r of l) REGION_CLASS[r] = c;
  // [ore, true security at or below which it appears]
  const NULL_ORES = {
    F: [["Bistot", -500], ["Arkonor", -600], ["Pyroxeres", -700], ["Mercoxit", -800]],
    G: [["Kernite", 0], ["Pyroxeres", -400], ["Bistot", -600], ["Mercoxit", -800]],
    H: [["Pyroxeres", 0], ["Kernite", -500], ["Mercoxit", -800], ["Bistot", -900]],
    I: [["Arkonor", -700], ["Mercoxit", -800], ["Kernite", -900]],
    J: [["Pyroxeres", 0], ["Bistot", -500], ["Mercoxit", -800], ["Arkonor", -900]],
    "Etherium Reach": [["Bistot", 0], ["Arkonor", -200], ["Mercoxit", -500]],
    "Cobalt Edge": [["Bistot", -600], ["Arkonor", -700], ["Mercoxit", -800]]
  };
  // -> { ores: [names], guess: true when the source has no clear answer for this system (then ores are possibilities) }
  function beltOres(sec, q, region) {
    if (sec >= 450) {
      const d = +secText(sec), ores = ["Veldspar", "Scordite"];
      if (d <= 0.9) ores.push(q === "G" || q === "M" ? "Plagioclase" : "Pyroxeres");
      if (q === "C" && d <= 0.7) ores.push("Plagioclase");
      return { ores, guess: !"ACGM".includes(q || "-") };
    }
    if (sec > 0) {
      if (!LOW_ORES[q]) return { ores: [...new Set(Object.values(LOW_ORES).flat())], guess: true };
      return { ores: [...LOW_ORES[q], ...(+secText(sec) <= 0.2 ? [LOW_DEEP[q]] : [])], guess: false };
    }
    if (region === "Pochven") return { ores: ["Bezdnacine", "Rakovene", "Talassonite"], guess: false };
    const table = NULL_ORES[region] || NULL_ORES[REGION_CLASS[region]];
    if (table) return { ores: table.filter(([, at]) => sec <= at).map(x => x[0]), guess: false };
    if (REGION_CLASS[region] === "K") return { ores: ["Bistot", "Arkonor", "Mercoxit"], guess: true };
    return { ores: [], guess: true };
  }
  // Where each belt ore is found, in words (Ore Values tab).
  const BELT_WHERE = {
    Veldspar: "Highsec belts", Scordite: "Highsec belts",
    Pyroxeres: "Highsec ≤0.9 (Amarr, Caldari), lowsec (Amarr, Caldari), nullsec",
    Plagioclase: "Highsec ≤0.9 (Gallente, Minmatar; Caldari ≤0.7)", Omber: "Lowsec (Gallente, Minmatar)",
    Kernite: "Lowsec (Amarr, Caldari, Minmatar), nullsec", Jaspet: "Lowsec (Amarr, Gallente)",
    Hemorphite: "Lowsec 0.2–0.1 (Amarr, Gallente)", Hedbergite: "Lowsec 0.2–0.1 (Caldari, Minmatar)",
    Bistot: "Nullsec (low true security)", Arkonor: "Nullsec (low true security)", Mercoxit: "Nullsec (≤ -0.8, or lower in some regions)"
  };

  // ---------------- which belt in a system ----------------
  const ROMAN = n => { let s = ""; for (const [v, r] of [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]) while (n >= v) { s += r; n -= v; } return s; };
  const pts = s => s ? s.split(",").map(x => x.split(":").map(Number)) : [];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 100; // AU
  // Belts of system index i, nearest to `from` ([x, y, z] in 0.01 AU) first: [{ name, planet, n, p, au }].
  function beltsOf(map, i, from) {
    const l = pts(map.bp && map.bp[i]).map(([pl, n, x, y, z]) => ({ name: `${map.names[i]} ${ROMAN(pl)} - Asteroid Belt ${n}`, planet: pl, n, p: [x, y, z] }));
    for (const b of l) b.au = from ? dist(b.p, from) : null;
    return from ? l.sort((a, b) => a.au - b.au || a.planet - b.planet || a.n - b.n) : l;
  }
  // Positions of the stations of system i, in "st" order; the stargate in system i that leads to system j.
  const stationPos = (map, i) => pts(map.sp && map.sp[i]).map(p => p.length === 3 ? p : null);
  const gateTo = (map, i, j) => { const g = pts(map.gp && map.gp[i]).find(x => x[0] === j); return g ? g.slice(1) : null; };

  // Share of the time spent mining when every full hold is taken to a station: fill time / (fill + trip).
  // Trip = there and back (2 x jumps x seconds per jump) + docking and undocking.
  function miningShare(hold, rate, jumps, secPerJump, dockSec) {
    if (!(hold > 0 && rate > 0)) return 1;
    const fill = hold / rate, trip = 2 * jumps * secPerJump + dockSec;
    return fill / (fill + trip);
  }

  const api = { taxFor, brokerFor, refineYield, mineralsPerUnit, fitStats, minerOut, canMine, isIceTool, isDeepCore, bookAt, netPrice,
    mapIndex, treeFrom, nearestOf, pathTo, secText, klass, BELT_ORES, beltOres, BELT_WHERE, REGION_CLASS, beltsOf, stationPos, gateTo, miningShare,
    slotOf, fitsShip, crystalFits, crystalOres, reqsMet, reqsOf, fitUse, bestFit, PRESET_STAGES, stageSkills };
  if (typeof module === "object" && module.exports) module.exports = api; else root.MINER_CORE = api;
})(typeof window !== "undefined" ? window : globalThis);
