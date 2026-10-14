// bun scripts/engine-test.mjs  - simulated learners against site/js/engine.js
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const E = createRequire(import.meta.url)("../js/engine.js");

// deterministic rng
let seed = 12345;
E.rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const randGraph = (n) => {
  const nodes = [];
  for (let i = 0; i < n; i++) {
    const prereqs = [];
    if (i > 0) { const k = 1 + Math.floor(E.rng() * 2); for (let j = 0; j < k; j++) { const p = "n" + Math.floor(E.rng() * i); if (!prereqs.includes(p)) prereqs.push(p); } }
    nodes.push({ id: "n" + i, prereqs });
  }
  return nodes;
};
const bank = (nodes) => Object.fromEntries(nodes.map((n) => [n.id, Object.fromEntries([0, 1, 2, 3].map((t) => [t, Array.from({ length: t === 0 ? 6 : 14 }, (_, i) => ({ q: n.id + t + i }))]))]));

// 1. placement -------------------------------------------------------------
for (const rating of ["some", "all"]) {
  let accSum = 0, askedSum = 0, baseSum = 0, trials = 300;
  for (let t = 0; t < trials; t++) {
    const nodes = randGraph(20), { anc } = E.closure(nodes);
    const known = new Set();
    const seeds = rating === "all" ? nodes.filter(() => E.rng() < 0.85) : nodes.filter(() => E.rng() < 0.3);
    seeds.forEach((n) => { known.add(n.id); anc[n.id].forEach((a) => known.add(a)); });
    const p = E.placement.create(nodes, rating);
    for (;;) {
      const id = E.placement.next(nodes, p); if (!id) break;
      let c = 0; for (let i = 0; i < 2; i++) if (E.rng() < (known.has(id) ? 0.95 : 0.25)) c++;
      E.placement.record(nodes, p, id, c, 2);
    }
    const r = E.placement.finish(nodes, p), kn = new Set(r.known);
    accSum += nodes.filter((n) => kn.has(n.id) === known.has(n.id)).length / nodes.length;
    askedSum += p.asked;
    baseSum += nodes.filter((n) => !known.has(n.id)).length / nodes.length; // "assume nothing known"
  }
  const acc = accSum / trials, asked = askedSum / trials, base = baseSum / trials;
  console.log(`placement[${rating}]: classified ${(acc * 100).toFixed(1)}% of concepts correctly in ${asked.toFixed(1)} questions (assume-unknown baseline ${(base * 100).toFixed(1)}%)`);
  assert(acc > base + 0.05, "placement must beat the do-nothing baseline");
  assert(asked <= 24);
}

// 2. adaptive difficulty -----------------------------------------------------
const pCorrect = (theta, tier) => 1 / (1 + Math.exp(-1.6 * (theta - [-0.5, 0.5, 1.5][tier - 1])));
for (const theta of [-0.2, 0.5, 1.2, 2.0]) {
  const nodes = randGraph(1), b = bank(nodes), S = E.init(nodes, "none", null, 0), node = S.nodes.n0;
  let right = 0, total = 0, exclude = new Set(), tiersHit = new Set(), repeats = 0;
  for (let i = 0; i < 400; i++) {
    if (i % 10 === 0) exclude = new Set(); // new session every 10 items
    const it = E.practiceItem(b, "n0", node, exclude); if (!it) { exclude = new Set(); continue; }
    const ok = E.rng() < pCorrect(theta + i * 0.002, it.tier);
    E.answer(node, it.key, ok, i); E.adjust(node, ok);
    tiersHit.add(it.tier); total++; right += ok ? 1 : 0;
  }
  const a = right / total;
  console.log(`difficulty[theta=${theta}]: accuracy ${(a * 100).toFixed(1)}%, final tier ${node.tier}, tiers used ${[...tiersHit].sort().join(",")}`);
  if (theta >= 0.5 && theta <= 1.2) assert(a > 0.68 && a < 0.93, "mid learners should sit near the 80-85% band");
}
{ // no repeats inside a session, and unseen items are used first
  const nodes = randGraph(1), b = bank(nodes), node = E.newNode(), ex = new Set(), keys = [];
  for (let i = 0; i < 14; i++) { const it = E.practiceItem(b, "n0", node, ex); keys.push(it.key); E.answer(node, it.key, true, i); }
  assert.equal(new Set(keys).size, keys.length);
  const fresh = E.draw(b, "n0", node, [1], 3, new Set()); // tier 1 is now fully seen once
  assert(fresh.every((f) => node.seen[f.key] === 1));
  const t2 = E.draw(b, "n0", node, [1, 2], 3, new Set());
  assert(t2.every((f) => f.tier === 2), "unseen items come before seen ones");
}

// 3. mastery rule --------------------------------------------------------------
{
  const mk = (cs) => ({ checks: cs.map(([c, n]) => ({ c, n })) });
  assert(E.isMastered(mk([[6, 6], [6, 6], [5, 6]])));
  assert(!E.isMastered(mk([[6, 6], [4, 6], [6, 6]])));
  assert(!E.isMastered(mk([[6, 6], [6, 6]])), "needs three tests");
  const nodes = randGraph(1), b = bank(nodes), node = E.newNode();
  const c = E.buildCheck(b, "n0", node, 6);
  assert.equal(new Set(c.map((x) => x.key)).size, 6);
  { // checks must be spaced to count
  const nodes = randGraph(1), S = E.init(nodes, "none", null, 0), t0 = 1e12;
  let o = E.recordCheck(S, "n0", 6, 6, t0, 6); assert(o.counted);
  o = E.recordCheck(S, "n0", 6, 6, t0 + 1000, 6); assert(!o.counted, "a check minutes later must not count");
  assert.equal(S.nodes.n0.checks.length, 1);
  o = E.recordCheck(S, "n0", 6, 6, t0 + E.CHECK_GAP, 6); assert(o.counted);
  o = E.recordCheck(S, "n0", 6, 6, t0 + 2 * E.CHECK_GAP, 6); assert(o.mastered && S.nodes.n0.state === "mastered");
  const b = bank(nodes), fresh = E.buildCheck(b, "n0", E.newNode(), 6); assert(fresh.every((x) => x.fresh === true));
}
console.log("mastery rule: pooled >= 90% over last three fresh-item checks (17/18 passes, 16/18 fails)");
}

// 4. review scheduling -----------------------------------------------------------
{
  const now = 0, test = new Date(Date.now() + 20 * E.DAY).toISOString().slice(0, 10);
  const S = { testDate: test, nodes: {} }, node = (S.nodes.a = E.newNode());
  node.state = "mastered"; node.due = 0;
  const gaps = [];
  let t = new Date(test + "T00:00:00").getTime() - 20 * E.DAY;
  for (let i = 0; i < 4; i++) { E.scheduleReview(S, node, true, t); gaps.push(Math.round((node.due - t) / E.DAY)); t = node.due; }
  console.log("review intervals (days, expanding, capped by test date):", gaps.join(", "));
  assert(gaps[1] > gaps[0] || gaps[1] >= 1);
  assert(node.due <= new Date(test + "T00:00:00").getTime() - E.DAY + E.DAY / 2);
  const before = node.box; E.scheduleReview(S, node, false, t);
  assert(node.box < before || before === 0); assert.equal(node.lapses, 1);
}

// 5. plan ---------------------------------------------------------------------------
{
  const nodes = randGraph(10), now = new Date(2026, 0, 1).getTime();
  const S = E.init(nodes, "none", (() => { const d = new Date(2026, 0, 11); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })(), now);
  const p = E.plan(S, nodes, now);
  assert.equal(p.teachDays, 8); assert.equal(p.buffer, 2); assert.equal(p.newPerDay, 2);
  assert(p.today.new.length <= 2 && p.today.new.every((id) => (nodes.find((n) => n.id === id).prereqs).length === 0));
  console.log(`plan: 10 concepts, 10 days -> ${p.newPerDay}/day for ${p.teachDays} days, ${p.buffer} review-only days`);
}
console.log("all engine tests passed");
