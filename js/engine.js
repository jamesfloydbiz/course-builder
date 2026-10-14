// Learning engine for the course player. Pure functions over a plain-JSON learner state, so it
// can be tested in bun and costs nothing per learner. Rules come from the learnbyscience skill:
//   retrieval over review, ~85% success band, climb in steps / drop back when slipping,
//   mastery = ~90% on fresh items across several tests, spaced + interleaved review,
//   skip what the learner already shows they know (expertise reversal).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Engine = factory();
})(this, function () {
  const DAY = 86400000;
  const INTERVALS = [1, 3, 7, 14, 30]; // days between reviews, expanding
  const E = { rng: Math.random, DAY, INTERVALS };

  const shuffle = (a) => {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(E.rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  // ---------- graph helpers ----------
  E.closure = function (nodes) {
    const byId = {}, anc = {}, desc = {};
    nodes.forEach((n) => { byId[n.id] = n; anc[n.id] = new Set(); desc[n.id] = new Set(); });
    const visit = (id, seen) => {
      for (const p of byId[id].prereqs || []) {
        if (!byId[p] || seen.has(p)) continue;
        seen.add(p); visit(p, seen);
      }
    };
    nodes.forEach((n) => { visit(n.id, anc[n.id]); anc[n.id].delete(n.id); });
    nodes.forEach((n) => anc[n.id].forEach((a) => desc[a].add(n.id)));
    return { byId, anc, desc };
  };

  // ---------- placement: adaptive walk over the knowledge graph ----------
  // Passing a node proves its prerequisites; failing it implies what depends on it is unknown.
  E.placement = {
    create(nodes, rating) {
      return { rating, status: {}, tested: {}, asked: 0, maxNodes: rating === "all" ? 10 : 12 };
    },
    next(nodes, p) {
      if (Object.keys(p.tested).length >= p.maxNodes) return null;
      const D = new Set(nodes.filter((n) => !p.status[n.id]).map((n) => n.id));
      if (!D.size) return null;
      const { anc, desc } = E.closure(nodes);
      let best = [], bestScore = -1;
      for (const id of D) {
        const up = [...anc[id]].filter((x) => D.has(x)).length + 1;   // inferred known if passed
        const down = [...desc[id]].filter((x) => D.has(x)).length + 1; // inferred unknown if failed
        // someone who says "all": test the deepest nodes first (a pass settles the most).
        // someone who says "some": split the undecided nodes as evenly as possible.
        const score = p.rating === "all" ? up + 0.01 * Math.min(up, down) : Math.min(up, down) + 0.001 * up;
        if (score > bestScore + 1e-9) { bestScore = score; best = [id]; } else if (Math.abs(score - bestScore) <= 1e-9) best.push(id);
      }
      return best[Math.floor(E.rng() * best.length)];
    },
    record(nodes, p, id, correct, asked) {
      const { anc, desc } = E.closure(nodes);
      p.tested[id] = { c: correct, n: asked };
      p.asked += asked;
      const pass = asked > 0 && correct === asked;
      p.status[id] = pass ? "known" : "unknown";
      (pass ? anc[id] : desc[id]).forEach((x) => { if (!p.status[x]) p.status[x] = pass ? "known" : "unknown"; });
    },
    finish(nodes, p) {
      const known = [], unknown = [], uncertain = [];
      nodes.forEach((n) => {
        const s = p.status[n.id];
        if (s === "known") known.push(n.id);
        else { unknown.push(n.id); if (!s) uncertain.push(n.id); }
      });
      return { known, unknown, uncertain };
    },
  };

  // ---------- learner state ----------
  E.newNode = () => ({ state: "new", tier: 1, level: 1, recent: [], since: 0, seen: {}, checks: [], box: 0, due: null, lapses: 0, placed: false, last: null });

  E.init = function (nodes, rating, testDate, now) {
    const S = { v: 2, rating, testDate, startedAt: now, placement: null, placed: false, nodes: {} };
    nodes.forEach((n) => (S.nodes[n.id] = E.newNode()));
    S.initialNew = nodes.length;
    return S;
  };

  const capDue = (due, S, now) => {
    if (!S.testDate) return due;
    const last = new Date(S.testDate + "T00:00:00").getTime() - DAY; // final review the day before
    return last <= now ? now + DAY / 2 : Math.min(due, last);
  };

  E.applyPlacement = function (S, nodes, p, now) {
    const r = E.placement.finish(nodes, p);
    r.known.forEach((id) => {
      const n = S.nodes[id];
      n.state = "known"; n.placed = true; n.box = 0; n.due = capDue(now + 2 * DAY, S, now);
    });
    r.unknown.forEach((id) => {
      const n = S.nodes[id], t = p.tested[id];
      n.level = t && t.c > 0 ? 2 : 1; n.tier = n.level; // partial credit: start one rung up
    });
    S.placement = p; S.placed = true;
    S.initialNew = r.unknown.length;
    return r;
  };

  // ---------- item selection: unseen first, never repeat within a session ----------
  E.draw = function (bank, id, node, tiers, count, exclude) {
    const cands = [];
    tiers.forEach((t) => ((bank[id] || {})[t] || []).forEach((item, i) => cands.push({ key: t + "." + i, tier: t, item })));
    const out = [];
    shuffle(cands).sort((a, b) => (node.seen[a.key] || 0) - (node.seen[b.key] || 0)).forEach((c) => {
      if (out.length < count && !exclude.has(id + ":" + c.key)) { exclude.add(id + ":" + c.key); out.push({ nodeId: id, ...c }); }
    });
    return out;
  };

  E.practiceItem = function (bank, id, node, exclude) {
    const order = [node.tier, node.tier - 1, node.tier + 1, node.tier - 2, node.tier + 2].filter((t) => t >= 1 && t <= 3);
    for (const t of order) {
      const got = E.draw(bank, id, node, [t], 1, exclude);
      if (got.length) return got[0];
    }
    return null;
  };

  // ---------- adaptive difficulty: weighted up-down staircase ----------
  // Small step up after a hit, big step back after a miss. The two steps balance at 85% correct
  // (0.15 * UP == 0.85 * DOWN would be the textbook ratio; here p*UP = (1-p)*DOWN at p = .85).
  // The level is continuous and the tier shown is the nearest rung, so the learner climbs in
  // steps and drops back one or two rungs when slipping, never straight to the floor.
  const UP = 0.15, DOWN = 0.85;
  E.answer = function (node, key, ok, now) {
    node.seen[key] = (node.seen[key] || 0) + 1;
    node.recent.push(ok ? 1 : 0); if (node.recent.length > 8) node.recent.shift();
    node.since++; node.last = now;
  };

  E.adjust = function (node, ok) {
    const before = node.tier;
    node.level = Math.min(3.49, Math.max(1, node.level + (ok ? UP : -Math.min(DOWN, node.level - 1 + 0.35))));
    node.tier = Math.max(1, Math.min(3, Math.round(node.level)));
    const w = node.recent.slice(-6);
    return { event: node.tier > before ? "up" : node.tier < before ? "down" : "hold", acc: acc(w) };
  };
  const acc = (w) => (w.length ? w.reduce((s, x) => s + x, 0) / w.length : null);

  // ---------- mastery: fresh, harder items, no feedback until the end; pooled >= 90% over three tests ----------
  E.buildCheck = function (bank, id, node, size) {
    size = size || 6;
    const ex = new Set();
    const hard = E.draw(bank, id, node, [3], Math.ceil(size / 2), ex);
    const mid = E.draw(bank, id, node, [2], size - hard.length, ex);
    let items = hard.concat(mid);
    if (items.length < size) items = items.concat(E.draw(bank, id, node, [1, 2, 3], size - items.length, ex));
    items.forEach((x) => (x.fresh = !(node.seen[x.key] > 0)));
    return shuffle(items);
  };

  E.isMastered = function (node) {
    const c = node.checks.slice(-3);
    if (c.length < 3) return false;
    const right = c.reduce((s, x) => s + x.c, 0), n = c.reduce((s, x) => s + x.n, 0);
    return right / n >= 0.9;
  };

  // A check only counts toward mastery if it comes well after the previous counted one:
  // remembering after a gap is what shows learning; repeating right away shows short-term recall.
  E.CHECK_GAP = 2 * 3600 * 1000;
  E.recordCheck = function (S, id, correct, n, now, fresh) {
    const node = S.nodes[id], prev = node.checks[node.checks.length - 1];
    const counted = !prev || now - prev.t >= E.CHECK_GAP;
    node.last = now;
    const slipped = () => { if (correct / n < 0.67 && node.tier > 1) { node.level = Math.max(1, node.level - 1); node.tier = Math.max(1, Math.round(node.level)); node.since = 0; node.recent = []; } };
    if (!counted) { if (node.state !== "mastered") node.state = "learning"; slipped(); return { mastered: false, counted: false, nextCount: prev.t + E.CHECK_GAP }; }
    node.checks.push({ c: correct, n, t: now, fresh: fresh == null ? n : fresh });
    if (node.checks.length > 6) node.checks.shift();
    if (E.isMastered(node)) {
      node.state = "mastered"; node.box = 0; node.due = capDue(now + INTERVALS[0] * DAY, S, now);
      return { mastered: true, counted: true };
    }
    node.state = "learning"; slipped();
    return { mastered: false, counted: true, checksLeft: Math.max(0, 3 - node.checks.length) };
  };

  // ---------- spaced, interleaved review ----------
  E.scheduleReview = function (S, node, ok, now) {
    if (ok) { node.box = Math.min(node.box + 1, INTERVALS.length - 1); node.due = capDue(now + INTERVALS[node.box] * DAY, S, now); }
    else { node.box = Math.max(0, node.box - 2); node.lapses++; node.level = Math.max(1, node.level - 1); node.tier = Math.max(1, Math.round(node.level)); node.due = capDue(now + DAY, S, now); }
  };

  E.dueNodes = (S, now) => Object.keys(S.nodes).filter((id) => ["mastered", "known"].includes(S.nodes[id].state) && S.nodes[id].due != null && S.nodes[id].due <= now);

  E.buildReview = function (S, bank, now, max) {
    max = max || 18;
    const due = E.dueNodes(S, now);
    const per = Math.max(2, Math.min(3, Math.floor(max / Math.max(1, due.length))));
    let items = [];
    due.forEach((id) => {
      const node = S.nodes[id];
      items = items.concat(E.draw(bank, id, node, [Math.max(2, node.tier), 2, 3, 1], per, new Set()));
    });
    return shuffle(items).slice(0, max); // interleaved across concepts, not blocked
  };

  E.recordReview = function (S, id, correct, n, now) {
    const node = S.nodes[id], ok = n > 0 && correct / n >= 0.67;
    if (!ok && node.state === "known") { node.state = "learning"; node.placed = false; } // placement guess was wrong
    if (ok && node.state === "known") node.state = "mastered";
    E.scheduleReview(S, node, ok, now);
    return ok;
  };

  // ---------- daily plan and readiness ----------
  const done = (S, id) => ["mastered", "known"].includes(S.nodes[id].state);

  E.plan = function (S, nodes, now) {
    const test = S.testDate ? new Date(S.testDate + "T00:00:00").getTime() : null;
    const daysLeft = test ? Math.max(1, Math.ceil((test - now) / DAY)) : 30;
    const buffer = daysLeft >= 7 ? Math.ceil(daysLeft * 0.2) : 0; // last stretch is review only
    const teachDays = Math.max(1, daysLeft - buffer);
    const remaining = nodes.filter((n) => !done(S, n.id)).map((n) => n.id);
    const newPerDay = remaining.length ? Math.ceil(remaining.length / teachDays) : 0;
    const open = (id) => (S.nodes[id] && nodes.find((n) => n.id === id).prereqs || []).every((p) => !S.nodes[p] || done(S, p));
    const learning = remaining.filter((id) => S.nodes[id].state === "learning");
    const fresh = remaining.filter((id) => S.nodes[id].state === "new" && open(id));
    const today = learning.concat(fresh).slice(0, Math.max(newPerDay, learning.length ? 1 : 0));
    const elapsed = Math.max(0, (now - S.startedAt) / DAY);
    const expectedLeft = (S.initialNew || nodes.length) * Math.max(0, 1 - elapsed / Math.max(1, teachDays + buffer * 0));
    return {
      daysLeft, teachDays, buffer, remaining, newPerDay,
      today: { review: E.dueNodes(S, now), new: today },
      locked: remaining.filter((id) => !open(id) && S.nodes[id].state === "new"),
      onTrack: remaining.length <= Math.ceil(expectedLeft),
      readiness: E.readiness(S, nodes, now),
    };
  };

  E.readiness = function (S, nodes, now) {
    let total = 0;
    nodes.forEach((n) => {
      const x = S.nodes[n.id];
      if (["mastered", "known"].includes(x.state)) {
        const last3 = x.checks.slice(-3), n3 = last3.reduce((s, c) => s + c.n, 0);
        let p = n3 ? last3.reduce((s, c) => s + c.c, 0) / n3 : 0.8;
        const overdue = x.due != null ? Math.max(0, (now - x.due) / DAY) : 0;
        total += p * Math.exp(-overdue / Math.max(1, INTERVALS[x.box]));
      } else if (x.state === "learning") total += 0.5 * (acc(x.recent) ?? 0.4);
    });
    return nodes.length ? total / nodes.length : 0;
  };

  return E;
});
