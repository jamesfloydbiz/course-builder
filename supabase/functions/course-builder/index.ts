import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

// Course builder v2. Content only: standards -> knowledge graph -> lessons + question bank.
// All learning-science algorithms (placement, adaptive difficulty, spacing, mastery) run in the
// browser (site/js/engine.js) so they cost nothing per learner.
// One call = one small unit of work (free-tier request limit); the browser drives the loop.

const MODEL = "claude-sonnet-5-5";
const DAILY_CALL_CAP = 600; // global spend guard: ~$0.02 per call on claude-sonnet-5-5, so ~$12/day at most
const MAX_SOURCE_CHARS = 120_000;
const MAX_NODES = 40;
const TIERS = [0, 1, 2, 3];
const TIER_SIZE: Record<number, number> = { 0: 6, 1: 14, 2: 14, 3: 14 };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const PLAIN = `WRITING RULES (non-negotiable):
- Define or drop every technical term. A term the learner has not met is defined in one plain sentence at first use, or the sentence is rewritten without it. This includes words that feel elementary to a specialist.
- One domain per explanation. If a concept is taught through one kind of example, stay in it for the whole lesson.
- One idea per step. Each step has one example and at most one thing to do. At most 3 new elements (a new word, symbol, idea, or relationship) per step.
- Short sentences, common words. Match the reading level of the learner implied by the source material (read it as that learner). No praise before content. No hint questions that contain the answer.
- Never write "imagine". If the idea has a visible shape, describe the concrete numbers or objects directly instead of asking the learner to picture it.`;

const SCIENCE = `LEARNING-SCIENCE RULES:
- Explicit instruction first: explain the skill, do it in front of them (worked example), guide them through one, then fade guidance until they do one alone.
- Practice is retrieval, not rereading. Questions require producing or choosing an answer from memory.
- Feedback on every question says what the right process was and where a learner's likely error comes from. About the task, never the person.
- Wrong options must be plausible errors a real learner would make (a sign slip, a misremembered rule, a common misconception), never silly. All four options are the same length and detail; the right one is never the longest.`;

// Models sometimes return almost-valid JSON: unescaped double quotes inside a string (dialogue in a
// word problem), stray backslashes (\% \$), raw newlines in strings, trailing commas. Repair those
// in a single string-aware pass before giving up.
function repairJson(t: string): string {
  let out = "", inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (!inStr) { out += c; if (c === '"') inStr = true; continue; }
    if (c === "\\") {
      const n = t[i + 1];
      if (n !== undefined && '"\\/bfnrtu'.includes(n)) { out += c + n; i++; } else out += "\\\\";
      continue;
    }
    if (c === '"') {
      const next = t.slice(i + 1).match(/^\s*(.)/);
      if (!next || ",:}]".includes(next[1])) { out += c; inStr = false; } else out += '\\"'; // inner quote
      continue;
    }
    if (c === "\n") out += "\\n"; else if (c === "\r") out += ""; else if (c === "\t") out += "\\t";
    else if (c < " ") out += " "; else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

async function claude(courseId: string, system: string, user: string, maxTokens = 6000, think = false, label?: { action: string; node_id?: string; tier?: number }): Promise<any> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY is not configured");
  const { data: used } = await admin.rpc("bump_usage");
  if ((used as number) > DAILY_CALL_CAP) throw new Error("Daily build capacity reached. Try again tomorrow.");
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        ...(think ? {} : { thinking: { type: "between_tools" } }),
        system: system + "\n\nReturn ONLY valid JSON. No prose, no code fences. Inside any string value, write quoted speech with single quotes and never use a bare double quote; escape any double quote you must use as \\\".",
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) {
      if (attempt === 1) throw new Error(`Model call failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
      continue;
    }
    const d = await r.json();
    await admin.rpc("add_tokens", { cid: courseId, tin: d.usage?.input_tokens ?? 0, tout: d.usage?.output_tokens ?? 0 });
    if (label) await admin.from("build_log").insert({ course_id: courseId, action: label.action, node_id: label.node_id ?? null, tier: label.tier ?? null, tokens_in: d.usage?.input_tokens ?? 0, tokens_out: d.usage?.output_tokens ?? 0, ms: Date.now() - t0 });
    const raw = (d.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
    const m = raw.match(/\{[\s\S]*\}/);
    const body = m ? m[0] : raw;
    try { return JSON.parse(body); } catch {
      const fixed = repairJson(body);
      try { return JSON.parse(fixed); } catch (e2) {
        const msg = String((e2 as Error).message);
        const pos = Number(msg.match(/position (\d+)/)?.[1] ?? -1);
        last = `stop=${d.stop_reason} len=${raw.length} ${msg.slice(0, 80)} near=${pos >= 0 ? fixed.slice(Math.max(0, pos - 60), pos + 60) : fixed.slice(-120)}`;
      }
    }
  }
  throw new Error("Model returned invalid JSON twice: " + last);
}

// ---------- answer-position shuffle (generators love putting the key at option A) ----------
function shuffleItem(it: any) {
  if (!Array.isArray(it?.o) || typeof it.a !== "number" || it.a < 0 || it.a >= it.o.length) return null;
  const idx = it.o.map((_: any, i: number) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return { ...it, o: idx.map((i: number) => it.o[i]), a: idx.indexOf(it.a) };
}
async function sha(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t.toLowerCase().replace(/\s+/g, " ").trim()));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// ---------- generic verifier: solve blind, then compare to the key ----------
async function verifyList(courseId: string, list: any[], label?: any): Promise<{ list: any[]; fixed: number; dropped: number }> {
  if (!list.length) return { list, fixed: 0, dropped: 0 };
  const v = await claude(
    courseId,
    `You are an exam proofreader. For each question, solve it yourself from scratch WITHOUT looking at the given answer key, then compare. Report only problems: wrong key, more than one correct option, no correct option, two options that are numerically or logically equivalent, ambiguous wording, an explanation that contradicts the key, the correct option being noticeably longer or more detailed than the others, or an option containing commentary that reveals it is wrong. For a length or commentary problem, return new_options: four rewritten options of similar length, with the correct one at the same index as before. Schema: {"fixes":[{"ref":number,"issue":string,"correct_index":number|null,"new_explanation":string|null,"new_options":[string]|null,"drop":boolean}]}. "drop" true when it cannot be repaired. Empty list if all good.`,
    JSON.stringify(list.map((x, i) => ({ ref: i, q: x.q, o: x.o }))) + "\n\nGIVEN KEYS (look only after solving): " + JSON.stringify(list.map((x, i) => ({ ref: i, a: x.a }))),
    12000,
    true,
    label,
  );
  let fixed = 0, dropped = 0;
  const out = list.map((x) => ({ ...x }));
  for (const f of v.fixes ?? []) {
    const t = out[f.ref];
    if (!t) continue;
    if (f.drop) { t.__drop = true; dropped++; continue; }
    if (typeof f.correct_index === "number") t.a = f.correct_index;
    if (f.new_explanation) t.e = f.new_explanation;
    if (Array.isArray(f.new_options) && f.new_options.length === t.o.length) t.o = f.new_options.map(String);
    fixed++;
  }
  return { list: out.filter((x) => !x.__drop), fixed, dropped };
}

// ---------- stages ----------
async function stageStandards(c: any, src: string) {
  return await claude(
    c.id,
    `You are a curriculum designer using backward design. Given the learner's source material (standards, a study guide, or a syllabus), do steps 2-4 of this process:
2. Name the knowledge space(s) and what the learner must be able to do.
3. List every standard or learning objective present in the material, as written (short).
4. Translate each into an observable, measurable action (e.g. "has learned Bayes" -> "computes P(A|B) from a two-way table in under 2 minutes").
Also note who the learner appears to be (grade or age band, e.g. "grade 5", "undergraduate") so later writing matches their reading level.
Also decide whether anything is genuinely ambiguous in a way that changes what gets built (what level of depth, which exam format, which topics are in or out). Ask at most 3 clarifying questions, only if really needed; otherwise return an empty list. Every option must be something the learner can pick with one click: never offer an option that says they will provide more information later.
Schema: {"subject":string,"title":string,"learner":string,"exam_format":string,"standards":[{"id":"S1","text":string,"observable":string}],"questions":[{"id":"Q1","q":string,"options":[string]}]}`,
    `Test date: ${c.test_date}.\n\nSOURCE MATERIAL:\n${src}`,
    5000,
    false,
    { action: "standards" },
  );
}

async function stageGraph(c: any, standards: any, answers: any, feedback?: string, prev?: any) {
  return await claude(
    c.id,
    `You are building a knowledge graph for steps 5-7 of backward design. Build it from first principles and the definitions of the field, then cross-check against the standards (standards are a weak proxy for the real structure). Cover everything the exam or standards require. Each node is one concept with one observable action that demonstrates mastery, and its prerequisites. Prerequisites must only point to earlier nodes and should be sparse (only direct dependencies). Order nodes so prerequisites come first. Size the graph to the material: about 1.5 concepts per standard or major topic listed (a 7-standard unit is roughly 10-12 concepts; a full semester course is 25-40), never more than ${MAX_NODES}. A concept is something a learner can be tested on with about 6-10 questions; merge anything smaller into its neighbor. Then group nodes into units (related topics together) and give each unit one engaging anchoring activity.
Schema: {"nodes":[{"id":"n1","name":string,"concept":string,"observable":string,"prereqs":["n0"],"standards":["S1"],"unit":"u1","est_minutes":number}],"units":[{"id":"u1","title":string,"activity":string}]}`,
    `Subject: ${standards.subject}\nLearner: ${standards.learner}\nExam format: ${standards.exam_format}\nLearner answers to clarifying questions: ${JSON.stringify(answers ?? {})}\nStandards: ${JSON.stringify(standards.standards)}${feedback ? `\n\nThe learner reviewed an earlier version of this graph (concepts: ${(prev?.nodes ?? []).map((n: any) => n.name).join("; ")}). Apply their feedback and return a full revised graph: ${String(feedback).slice(0, 600)}` : ""}`,
    12000,
    false,
    { action: feedback ? "regraph" : "graph" },
  );
}

async function stageLesson(c: any, node: any, graph: any, standards: any, src: string) {
  const prereqNames = (node.prereqs ?? []).map((id: string) => graph.nodes.find((n: any) => n.id === id)?.name).filter(Boolean);
  return await claude(
    c.id,
    `You write one lesson for one node of a course, for a self-studying learner. ${PLAIN}\n${SCIENCE}
Lesson structure, in this order:
1. review: 2 retrieval questions on the prerequisite concepts (empty list if none). New surface, not copied from the prerequisite lessons.
2. motivating_problem: a problem they cannot solve yet, solved better by the new skill.
3. steps: explicit instruction in small chunks. Each step: {"text", "check": {"q","o":[4 options],"a":index,"e":explanation}}. The check on a step must test the idea of THAT step on a NEW case (different numbers or context from the text). Do not reuse a worked example's numbers in a check.
4. worked_examples: 3 examples of the same skill. First is fully worked with the reasoning said out loud. Second is partly worked, with "your_turn" for the last step. Third is "your_turn" only. Each: {"problem","worked":[string],"your_turn":string|null,"answer":string}.
Use ONLY facts consistent with the source material. If the source does not cover something, teach it from standard definitions of the field.
Schema: {"title":string,"review":[{"q","o","a","e"}],"motivating_problem":string,"steps":[...],"worked_examples":[...]}`,
    `Course subject: ${standards.subject}\nLearner: ${standards.learner}\nNode: ${JSON.stringify(node)}\nPrerequisites: ${prereqNames.join(", ") || "none"}\nSource excerpt:\n${src.slice(0, 30000)}`,
    10000,
    false,
    { action: "lesson", node_id: node.id },
  );
}

const TIER_SPEC: Record<number, string> = {
  0: "DIAGNOSTIC (6 questions). Each independently tests whether the learner has the concept already, at a moderate level, with different surface contexts. Not answerable by test-taking tricks. No question may depend on another.",
  1: "TIER 1, EASY (14 questions). One-step or lightly scaffolded, familiar context, a clear single idea. Purpose: early wins for someone just starting. Vary numbers and contexts.",
  2: "TIER 2, EXAM LEVEL (14 questions). Typical of what the exam will ask: multi-step, near transfer (same structure as taught, new numbers and context).",
  3: "TIER 3, HARD (14 questions). Far transfer: new contexts and structures the lessons did not use, misconception-based wrong options, and combinations with prerequisite concepts. A well-prepared learner should still miss about one in three.",
};

async function stageBank(c: any, node: any, tier: number, standards: any, src: string) {
  const out = await claude(
    c.id,
    `You write a question bank for one concept of a course. ${PLAIN}\n${SCIENCE}
Write ${TIER_SPEC[tier]}
Format: multiple choice with exactly 4 options, one correct. Convert any short-answer exam format into multiple choice with plausible wrong values. Every question must be fully self-contained and different in numbers and context from the others in this batch. Explanation: at most 2 sentences, states the right process and the likely error behind the most tempting wrong option. Put the correct option at a RANDOM position. Make all four options the same length and level of detail: the correct option must NOT be the longest or most detailed, so write the wrong options with equal care. Never put commentary inside an option (no "X is wrong" or "not correct" text); options are just the candidate answers.
Schema: {"items":[{"q":string,"o":[string,string,string,string],"a":index,"e":string}]}`,
    `Course subject: ${standards.subject}\nLearner: ${standards.learner}\nExam format: ${standards.exam_format}\nConcept: ${JSON.stringify(node)}\nSource excerpt:\n${src.slice(0, 20000)}`,
    9000,
    false,
    { action: "bank", node_id: node.id, tier },
  );
  const seen = new Set<string>();
  const items = (out.items ?? []).filter((x: any) => {
    const k = norm(x.q);
    if (!k || seen.has(k) || !Array.isArray(x.o) || x.o.length !== 4) return false;
    seen.add(k); return true;
  }).slice(0, TIER_SIZE[tier]);
  if (items.length < Math.min(4, TIER_SIZE[tier])) throw new Error("Question batch came back too small");
  return items;
}

// ---------- handler ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: u } = await admin.auth.getUser(token);
    const uid = u?.user?.id;
    if (!uid) return json({ error: "Sign-in required" }, 401);
    const body = await req.json();

    if (body.action === "create") {
      const text = String(body.text ?? "").slice(0, MAX_SOURCE_CHARS);
      if (text.trim().length < 200) return json({ error: "Upload more material (at least a paragraph or two)." }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(body.test_date ?? "") || new Date(body.test_date) <= new Date())
        return json({ error: "Pick a test date in the future." }, 400);
      const hash = await sha(text);
      if (!body.force_new) { // reuse: identical material already has a finished course (the caller's own, or a published one)
        const { data: ex } = await admin.from("courses").select("id,title").eq("source_hash", hash).eq("status", "ready")
          .or(`owner.eq.${uid},published.eq.true`).order("created_at", { ascending: false }).limit(1);
        if (ex && ex.length) return json({ existing: ex[0].id, title: ex[0].title });
      }
      const { data: c, error } = await admin.from("courses").insert({
        owner: uid, title: String(body.title ?? "My course").slice(0, 120), test_date: body.test_date,
        source_hash: hash, status: "building", stage: "standards", author: String(body.author ?? "").slice(0, 60) || null,
      }).select().single();
      if (error) throw error;
      await admin.from("course_sources").insert({ course_id: c.id, owner: uid, source_text: text });
      return json({ id: c.id, stage: "standards" });
    }

    const { data: c } = await admin.from("courses").select("*").eq("id", body.course_id).eq("owner", uid).single();
    if (!c) return json({ error: "Course not found" }, 404);
    const { data: s } = await admin.from("course_sources").select("source_text").eq("course_id", c.id).single();
    const src = s?.source_text ?? "";
    if (c.status === "failed") { await admin.from("courses").update({ status: "building" }).eq("id", c.id); c.status = "building"; }
    const save = async (patch: any) => { await admin.from("courses").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", c.id); };
    const reviewPayload = (cc: any) => ({
      stage: "review",
      nodes: cc.spec.graph.nodes.map((n: any) => ({ id: n.id, name: n.name, observable: n.observable, prereqs: n.prereqs ?? [] })),
      units: cc.spec.graph.units ?? [],
      regraphs: cc.progress?.regraphs ?? 0,
    });
    const nodeOf = (id: string) => c.spec.graph.nodes.find((n: any) => n.id === id);

    try {
      if (body.action === "step") {
        if (c.stage === "standards") {
          const r = await stageStandards(c, src);
          await save({ title: r.title || c.title, subject: r.subject, spec: { standards: r, answers: null },
            stage: r.questions?.length ? "clarify" : "graph" });
          return json({ stage: r.questions?.length ? "clarify" : "graph", questions: r.questions ?? [], standards: r.standards });
        }
        if (c.stage === "clarify") return json({ stage: "clarify", questions: c.spec.standards.questions });
        if (c.stage === "graph") {
          const g = await stageGraph(c, c.spec.standards, c.spec.answers);
          if (!g.nodes?.length) throw new Error("Graph came back empty");
          g.nodes = g.nodes.slice(0, MAX_NODES);
          await save({ spec: { ...c.spec, graph: g }, stage: "review" });
          c.stage = "review"; c.spec = { ...c.spec, graph: g };
        }
        if (c.stage === "review") return json(reviewPayload(c));
        if (c.stage === "lessons") {
          const { data: ls } = await admin.from("course_lessons").select("node_id,content").eq("course_id", c.id);
          const { data: its } = await admin.from("course_items").select("node_id,tier,verified").eq("course_id", c.id);
          return json({
            stage: "lessons",
            nodes: c.spec.graph.nodes.map((n: any) => ({ id: n.id, name: n.name })),
            lessons: (ls ?? []).map((l: any) => ({ id: l.node_id, verified: !!l.content?.verified })),
            items: (its ?? []).map((i: any) => ({ id: i.node_id, tier: i.tier, verified: i.verified })),
          });
        }
        if (c.stage === "ready") return json({ stage: "ready" });
      }

      if (body.action === "approve") {
        if (c.stage !== "review") return json({ error: "Nothing to approve" }, 409);
        await save({ stage: "lessons" });
        return json({ stage: "lessons" });
      }

      if (body.action === "regraph") {
        if (c.stage !== "review") return json({ error: "Not at the review step" }, 409);
        const used = c.progress?.regraphs ?? 0;
        if (used >= 3) return json({ error: "You've used the 3 revisions. Approve this version or start over." }, 429);
        const g = await stageGraph(c, c.spec.standards, c.spec.answers, String(body.feedback ?? ""), c.spec.graph);
        if (!g.nodes?.length) throw new Error("Graph came back empty");
        g.nodes = g.nodes.slice(0, MAX_NODES);
        await save({ spec: { ...c.spec, graph: g }, progress: { ...(c.progress ?? {}), regraphs: used + 1 } });
        return json(reviewPayload({ ...c, spec: { ...c.spec, graph: g }, progress: { regraphs: used + 1 } }));
      }

      if (body.action === "answer") {
        await save({ spec: { ...c.spec, answers: body.answers }, stage: "graph" });
        return json({ stage: "graph" });
      }

      if (body.action === "lesson") {
        const node = nodeOf(body.node_id);
        if (!node) return json({ error: "Unknown node" }, 400);
        const content = await stageLesson(c, node, c.spec.graph, c.spec.standards, src);
        await admin.from("course_lessons").upsert({ course_id: c.id, node_id: node.id, content });
        return json({ ok: true });
      }

      if (body.action === "verify_lesson") {
        const { data: row } = await admin.from("course_lessons").select("content").eq("course_id", c.id).eq("node_id", body.node_id).single();
        if (!row) return json({ error: "Lesson missing" }, 409);
        const L = row.content;
        const flat = [...(L.review ?? []), ...(L.steps ?? []).map((st: any) => st.check).filter(Boolean)];
        const v = await verifyList(c.id, flat, { action: "verify_lesson", node_id: body.node_id });
        const fixed = new Map(v.list.map((x: any) => [x.q, x]));
        const redo = (it: any) => { const f = fixed.get(it?.q); return f ? shuffleItem(f) : null; };
        L.review = (L.review ?? []).map(redo).filter(Boolean);
        L.steps = (L.steps ?? []).map((st: any) => ({ ...st, check: st.check ? redo(st.check) : null })).filter((st: any) => st.text);
        L.verified = true; L.verification = { fixed: v.fixed, dropped: v.dropped };
        await admin.from("course_lessons").upsert({ course_id: c.id, node_id: body.node_id, content: L });
        return json({ ok: true });
      }

      if (body.action === "bank") {
        const node = nodeOf(body.node_id);
        const tier = Number(body.tier);
        if (!node || !TIERS.includes(tier)) return json({ error: "Bad node or tier" }, 400);
        const items = await stageBank(c, node, tier, c.spec.standards, src);
        await admin.from("course_items").upsert({ course_id: c.id, node_id: node.id, tier, items, verified: false });
        return json({ ok: true, n: items.length });
      }

      if (body.action === "verify_bank") {
        const tier = Number(body.tier);
        const { data: row } = await admin.from("course_items").select("items").eq("course_id", c.id).eq("node_id", body.node_id).eq("tier", tier).single();
        if (!row) return json({ error: "Batch missing" }, 409);
        const v = await verifyList(c.id, row.items, { action: "verify_bank", node_id: body.node_id, tier });
        const items = v.list.map(shuffleItem).filter(Boolean);
        await admin.from("course_items").upsert({ course_id: c.id, node_id: body.node_id, tier, items, verified: true });
        return json({ ok: true, fixed: v.fixed, dropped: v.dropped, n: items.length });
      }

      if (body.action === "finish") {
        const nodes = c.spec.graph.nodes;
        const { data: ls } = await admin.from("course_lessons").select("node_id,content").eq("course_id", c.id);
        const { data: its } = await admin.from("course_items").select("node_id,tier,verified").eq("course_id", c.id);
        const okL = (ls ?? []).filter((l: any) => l.content?.verified).length;
        const okI = (its ?? []).filter((i: any) => i.verified).length;
        if (okL < nodes.length || okI < nodes.length * TIERS.length)
          return json({ error: "Some pieces are still missing", lessons: okL, batches: okI, need: nodes.length * TIERS.length }, 409);
        await save({ status: "ready", stage: "ready" });
        return json({ stage: "ready" });
      }
    } catch (e) {
      await save({ status: c.status === "ready" ? "ready" : "failed" });
      throw e;
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message ?? "Server error" }, 500);
  }
});
