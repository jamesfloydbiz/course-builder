# Course Builder

Upload standards, a study guide or a syllabus, set a test date, and get a study course built from it. Courses are saved to the learner's account and shared in a public library by default (they can opt out before building, or unshare later). The uploaded file itself is never shared.

- **Library / player:** https://jamesfloydbiz.github.io/course-builder/
- **Builder:** https://jamesfloydbiz.github.io/course-builder/build/
- Full STAT 1201 trainer (by Emmanuella): https://jamesfloydbiz.github.io/course-builder/trainers/stat1201/
- Part of [jamesfloyds.world](https://jamesfloyds.world/projects/tech-builds/)

## What it does

**Building** (about 10 to 15 minutes for 20 concepts). The process follows the eight steps in the essay [How to Design Academic Learning for Kids](https://jamesfloyds.world/writing/rabbit-holes/designing-academic-learning/):

1. Read the material into standards, each rewritten as something observable and measurable. Ask a few clarifying questions only if something truly changes what gets built.
2. Build a knowledge graph: one concept per node, each with an observable skill and its prerequisites.
3. **Review screen:** the builder shows the concept list and takes feedback ("fewer concepts", "something's missing") before the expensive part. Up to three revisions.
4. For each concept, write a lesson and about 48 practice questions (a placement set plus three difficulty tiers). Every batch is then checked by a second pass that solves each question blind and compares it to the key. Answer positions are shuffled server-side.

**Studying.** All learning logic runs in the browser (`js/engine.js`), so it costs nothing per learner:

- Self-rating (none / some / all). "Some" and "all" run an adaptive placement test over the graph: passing a concept marks its prerequisites known; failing one marks what depends on it unknown.
- Daily plan from days left and concepts unknown (the last ~20% of days are review only).
- Practice uses a weighted up-down staircase that holds the learner near 85% correct.
- Mastery = 90% pooled across three checks at least 2 hours apart, on new questions first.
- Spaced review at 1, 3, 7, 14 and 30 days (capped the day before the test), mixed across concepts.
- Answers are hidden until the learner commits; lesson checks come one step after the text that teaches them.

The design follows the `learnbyscience` and `teach-plainly` Claude skills.

## Architecture

| Piece | Where |
|---|---|
| Static site (library + player, builder) | this repo, GitHub Pages |
| Backend | one Supabase Edge Function, `supabase/functions/course-builder` |
| Database | Supabase Postgres, `supabase/migrations` (row-level security on every table) |
| Model | `claude-sonnet-5-5` called only from the Edge Function; the API key is a Supabase secret |

Learners sign in anonymously (no email) and can attach an email later to keep their account across devices.

## Setting it up

1. Create a Supabase project. Turn on **Authentication → Sign In / Providers → Allow anonymous sign-ins**, and add your site URL to the auth redirect allow-list.
2. Apply the files in `supabase/migrations/` in order. Optionally run `supabase/seed.sql` for the STAT 1201 course.
3. Set the secret `ANTHROPIC_API_KEY` (Edge Functions → Secrets), then deploy `supabase/functions/course-builder` with JWT verification **on**.
4. Put your project URL and publishable key in `js/learn.js`. (The publishable key is meant to be public; row-level security is what protects the data.)
5. Serve the repo root as a static site.

## Cost and limits

`claude-sonnet-5-5` is $2 per million input tokens and $10 per million output tokens. Measured on a 20-concept course: about 340k input and 335k output tokens, roughly **$4 to $5** per course. Each model call is logged in `build_log`:

```sql
select action, count(*), sum(tokens_in) tin, sum(tokens_out) tout,
       round((sum(tokens_in)*2.0 + sum(tokens_out)*10.0)/1e6, 2) usd
from build_log group by action order by usd desc;
```

There is no per-person limit on builds. A global cap of 600 model calls a day (`DAILY_CALL_CAP` in the function) bounds spend at roughly $12 to $24 a day. Set a monthly spend limit on the Anthropic key too.

## Tests

```
bun tests/engine-test.mjs
```

Simulated learners check the placement test, difficulty control, mastery rule, review scheduling and the daily plan.

## Known limits

- The builder runs in the browser tab: closing it pauses the build (it resumes from the same browser).
- Multiple choice only; no math typesetting or diagrams yet.
- Anyone can create anonymous accounts; there is no cap on stored courses per account.
