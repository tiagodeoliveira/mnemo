package extract

// ─────────────────────────────────────────────────────────────────────────────
// Extractor prompts — produce candidate NewItem lists from a conversation.
// ─────────────────────────────────────────────────────────────────────────────

// SystemExtractClassifier classifies the task domain and emits two separate
// fact streams that become NewItem candidates for /projects/.../ and /tasks/.../
// namespaces in handler.go. Output format: TASK:/PROJECT_FACTS:/TASK_FACTS:/DAILY:
// (parsed by parse.go).
//
// Two %s placeholders (same as before):
//   %s[0] — optional known-context block (project name / workdir)
//   %s[1] — domain list
const SystemExtractClassifier = `You are analyzing a conversation to extract durable knowledge — things a future session would benefit from knowing.
%s
1. CLASSIFY THE TASK DOMAIN: Pick exactly one:
%s
   If unclear, use "general". If too short to classify, output "unknown".

2. EXTRACT TWO KINDS OF INSIGHTS:

   PROJECT_FACTS — architectural truths about THIS specific codebase: components, services, deployment topology, schemas, naming conventions, the "why" behind structural decisions. Anything that would only be true for this project. If no project context, output NONE.

   TASK_FACTS — general patterns, lessons, anti-patterns, and reusable techniques tied to the task domain (coding, studying, meeting, general). Things that would be true even if applied to a different project. If nothing generalizable surfaced, output NONE.

   A fact belongs in exactly one bucket. If a fact is genuinely both, prefer PROJECT_FACTS. Skip facts that are commit-log noise (what was changed, in what file, by which command).

3. WRITE A DAILY LOG ENTRY: A detailed paragraph covering what was worked on, decisions made, problems encountered and how they were resolved, tools and technologies used, and any notable learnings. Be comprehensive — this will be consolidated into a daily digest later. Write 3-8 sentences.

Respond in this exact format:
TASK: <task_domain>
PROJECT_FACTS:
<one fact per line, or NONE>
TASK_FACTS:
<one fact per line, or NONE>
DAILY:
<3-8 sentence detailed log entry, or NONE if nothing meaningful>`

// SystemExtractAbout is the biographical extractor. Output: ABOUT: <lines>
// where each line becomes a NewItem candidate for the about dimension.
const SystemExtractAbout = `You are extracting biographical facts about the person (the "actor") who is participating in this conversation.

WHAT COUNTS AS ABOUT-ME CONTENT:
- Their name when stated ("I'm Tiago", "My name is Alice", or introduced in an email signature the user shared)
- Who they are: role, profession, background, experience, expertise areas
- What they're doing: active projects, responsibilities, long-running goals
- Where they come from: career history, education, notable past work
- Their domain: tools they use daily, technologies they specialize in, industries they work in
- People in their orbit: team, collaborators, family roles (only if explicitly stated)

STRICT ATTRIBUTION RULES:
- Extract from USER turns (first-person testimony): "I'm a principal engineer", "I work on mnemo", "I live in California".
- Extract from ASSISTANT turns ONLY when the assistant is responding to user-supplied content: the user shared a resume, pasted a bio, uploaded a profile, or asked the assistant to analyze something they provided. In that case the assistant's claims are grounded in the user's own material and are trustworthy.
- DO NOT extract assistant statements that are not grounded in something the user provided. Ignore generic advice, persona statements, or guesses.
- DO NOT infer. If a fact is not clearly stated, skip it.

WHAT TO SKIP:
- Transient state ("I'm tired today", "I'm annoyed at this bug")
- Opinions the user holds about tools, unless they define their identity (e.g., "I'm a Rust zealot" is about identity; "I don't like Java" is just an opinion)
- Operational preferences like coding style or communication style — those live elsewhere
- Implementation details of any project or codebase. It is fine to say "the actor is building a project called meeting_companion, a real-time meeting assistant" — a name and one-sentence scope. It is NOT fine to include version numbers, library names, source file paths, module names, port numbers, database choices, authentication providers, test counts, or any code-level detail. Those belong in project memory, never in the bio.

OUTPUT FORMAT:
ABOUT:
<one short factual statement per line, or NONE if nothing biographical surfaced>`

// SystemExtractPreferences yields NewItem candidates for the preferences
// dimension. Output: {"preferences": ["...", ...]}.
const SystemExtractPreferences = `Extract durable user preferences from this conversation: coding style, tool choices, workflow conventions.

Return a single JSON object: {"preferences": ["string", ...]}.

Rules:
- Only durable preferences a user has stated (or strongly implied), not one-off requests.
- Skip code snippets, file paths, version strings, port numbers.
- Prefer short declarative statements: "prefers tabs over spaces", "uses Go for backend services".
- Empty array if no preferences were expressed.
- Output JSON only. No prose, no code fences.`

// SystemExtractEpisodes yields structured episodes for the episodes dimension.
// Output: {"episodes": [{event, reflection}]}.
const SystemExtractEpisodes = `Extract structured episodes from this conversation.

Return a single JSON object:
{
  "episodes": [{ "event": "string", "reflection": "string" }, ...]
}

Rules:
- An episode is a discrete event the user described, paired with their reflection or takeaway.
- Skip if no reflection is apparent.
- Skip code/paths/version strings.
- Empty array if no episodes match.
- Output JSON only.`

// ─────────────────────────────────────────────────────────────────────────────
// Consolidation prompts — called once per dimension per event, with the full
// list of existing items and the newly-extracted candidates. The LLM returns a
// JSON diff (keep/reinforce/delete/update/insert).
// ─────────────────────────────────────────────────────────────────────────────

// SystemConsolidatePreferences is the consolidation prompt for the preferences
// dimension. Controlled tag vocabulary: language, tool, workflow, style,
// infrastructure, personal.
//
// No %s placeholders — the Go code builds the EXISTING ITEMS and NEW EXTRACTED
// ITEMS blocks and appends them to this base prompt at call time.
const SystemConsolidatePreferences = `You are consolidating the PREFERENCES memory for a personal memory system.

PURPOSE: Track durable coding preferences, tool choices, and workflow conventions. Preferences evolve; items not reinforced in ~12 months should be considered for deletion.

CONTROLLED TAG VOCABULARY (use only these tags, pick 1-3 per item):
  language, tool, workflow, style, infrastructure, personal

DIFF SCHEMA — return exactly this JSON object, no other text:
{
  "keep":      ["<ref>", ...],
  "reinforce": ["<ref>", ...],
  "delete":    ["<ref>", ...],
  "update":    [{"id": "<ref>", "content": "<string>", "tags": ["<tag>", ...]}, ...],
  "insert":    [{"content": "<string>", "tags": ["<tag>", ...]}]
}

Use the ref values shown beside each existing item ("ref: 1", "ref: 2", …). Never invent refs; only those that appear in EXISTING ITEMS are valid.

OPERATION SEMANTICS:
- keep: item remains exactly as-is (content, tags, dates all unchanged)
- reinforce: item is still true; bump its freshness date and reinforcement count
- delete: item is no longer true or is superseded; hard-delete it
- update: revise content and/or tags; keep the same ref row
- insert: brand-new item not present in existing items

RULES:
1. Every existing item ref MUST appear in exactly one of: keep, reinforce, delete, update[].id
2. Every insert must have non-empty content after trimming whitespace
3. Each item must be a single concise statement (one line, no sub-bullets)
4. Tags must be drawn from the controlled vocabulary above
5. Prefer reinforce over insert when the new item is semantically equivalent to an existing one
6. Prefer update over insert+delete when the new item supersedes an existing one
7. Delete items whose last_reinforced date is more than 12 months before today AND they are not reinforced by the new content
8. Output JSON only — no preamble, no code fences, no explanation`

// SystemConsolidateAbout is the consolidation prompt for the about dimension.
// Controlled tag vocabulary: identity, role, location, background, expertise,
// current-work. No automatic decay — stale facts are dropped only when
// explicitly contradicted by new content.
const SystemConsolidateAbout = `You are consolidating the ABOUT memory for a personal memory system.

PURPOSE: Track biographical facts about the person — who they are, their role, background, expertise, and ongoing work. This is identity-level information that rarely expires on its own; facts should only be dropped when the new content explicitly contradicts them.

CONTROLLED TAG VOCABULARY (use only these tags, pick 1-3 per item):
  identity, role, location, background, expertise, current-work

DIFF SCHEMA — return exactly this JSON object, no other text:
{
  "keep":      ["<ref>", ...],
  "reinforce": ["<ref>", ...],
  "delete":    ["<ref>", ...],
  "update":    [{"id": "<ref>", "content": "<string>", "tags": ["<tag>", ...]}, ...],
  "insert":    [{"content": "<string>", "tags": ["<tag>", ...]}]
}

Use the ref values shown beside each existing item ("ref: 1", "ref: 2", …). Never invent refs; only those that appear in EXISTING ITEMS are valid.

OPERATION SEMANTICS:
- keep: item remains exactly as-is (content, tags, dates all unchanged)
- reinforce: item is still true; bump its freshness date and reinforcement count
- delete: item is no longer true or is explicitly contradicted by new content
- update: revise content and/or tags; keep the same ref row
- insert: brand-new biographical fact not present in existing items

RULES:
1. Every existing item ref MUST appear in exactly one of: keep, reinforce, delete, update[].id
2. Every insert must have non-empty content after trimming whitespace
3. Each item must be a single concise factual statement
4. Tags must be drawn from the controlled vocabulary above
5. NO automatic decay based on age — about items expire only when contradicted
6. Prefer reinforce when the new content confirms an existing fact
7. Use update when the new content refines (not contradicts) an existing fact
8. Use delete only when the new content explicitly contradicts an existing fact
9. Output JSON only — no preamble, no code fences, no explanation`

// SystemConsolidateProject is the consolidation prompt for the project dimension.
// One %s placeholder: the project name.
// Controlled tag vocabulary: architecture, decision, constraint, tech-stack, status.
// No automatic decay — project facts are kept until explicitly superseded.
const SystemConsolidateProject = `You are consolidating the PROJECT memory for "%s".

PURPOSE: Track architecture decisions, design rationale, constraints, and high-level status for this project. Keep the "why" behind decisions, not implementation specifics. Project items do not decay on age alone — they are dropped only when superseded by new decisions.

CONTROLLED TAG VOCABULARY (use only these tags, pick 1-3 per item):
  architecture, decision, constraint, tech-stack, status

DIFF SCHEMA — return exactly this JSON object, no other text:
{
  "keep":      ["<ref>", ...],
  "reinforce": ["<ref>", ...],
  "delete":    ["<ref>", ...],
  "update":    [{"id": "<ref>", "content": "<string>", "tags": ["<tag>", ...]}, ...],
  "insert":    [{"content": "<string>", "tags": ["<tag>", ...]}]
}

Use the ref values shown beside each existing item ("ref: 1", "ref: 2", …). Never invent refs; only those that appear in EXISTING ITEMS are valid.

OPERATION SEMANTICS:
- keep: item remains exactly as-is (content, tags, dates all unchanged)
- reinforce: item is still true; bump its freshness date and reinforcement count
- delete: item is superseded by a new decision or no longer applicable
- update: revise content and/or tags; keep the same ref row
- insert: brand-new project fact not present in existing items

RULES:
1. Every existing item ref MUST appear in exactly one of: keep, reinforce, delete, update[].id
2. Every insert must have non-empty content after trimming whitespace
3. Each item must be a single concise statement
4. Tags must be drawn from the controlled vocabulary above
5. NO automatic decay based on age — project items do not expire on their own
6. Prefer reinforce when the new content confirms an existing decision or fact
7. Use update when the new content refines or supersedes an existing item
8. Use delete when a prior decision has been reversed by the new content
9. Output JSON only — no preamble, no code fences, no explanation`

// SystemConsolidateTask is the consolidation prompt for the task dimension.
// One %s placeholder: the task domain (e.g. "coding", "meeting").
// Controlled tag vocabulary: pattern, lesson, anti-pattern, convention.
// Decay: items not reinforced in ~12 months should be deleted.
const SystemConsolidateTask = `You are consolidating the TASK memory for the "%s" domain.

PURPOSE: Track transferable patterns, lessons, anti-patterns, and conventions that apply across sessions in this task domain. Task insights evolve; items not reinforced in ~12 months should be considered for deletion.

CONTROLLED TAG VOCABULARY (use only these tags, pick 1-3 per item):
  pattern, lesson, anti-pattern, convention

DIFF SCHEMA — return exactly this JSON object, no other text:
{
  "keep":      ["<ref>", ...],
  "reinforce": ["<ref>", ...],
  "delete":    ["<ref>", ...],
  "update":    [{"id": "<ref>", "content": "<string>", "tags": ["<tag>", ...]}, ...],
  "insert":    [{"content": "<string>", "tags": ["<tag>", ...]}]
}

Use the ref values shown beside each existing item ("ref: 1", "ref: 2", …). Never invent refs; only those that appear in EXISTING ITEMS are valid.

OPERATION SEMANTICS:
- keep: item remains exactly as-is (content, tags, dates all unchanged)
- reinforce: item is still true; bump its freshness date and reinforcement count
- delete: item is outdated or superseded
- update: revise content and/or tags; keep the same ref row
- insert: brand-new task insight not present in existing items

RULES:
1. Every existing item ref MUST appear in exactly one of: keep, reinforce, delete, update[].id
2. Every insert must have non-empty content after trimming whitespace
3. Each item must be a single concise statement (one line)
4. Tags must be drawn from the controlled vocabulary above
5. Prefer reinforce over insert when the new item is semantically equivalent to an existing one
6. Delete items whose last_reinforced date is more than 12 months before today AND they are not reinforced by the new content
7. Output JSON only — no preamble, no code fences, no explanation`
