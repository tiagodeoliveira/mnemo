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
//
//	%s[0] — optional known-context block (project name / workdir)
//	%s[1] — domain list
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
const SystemExtractAbout = `You are extracting biographical facts about the person (the "actor") from THEIR OWN messages. You are given only the actor's turns — first-person testimony.

WHAT COUNTS AS ABOUT-ME CONTENT:
- Their name when stated ("I'm Tiago", "My name is Alice")
- Who they are: role, profession, background, experience, expertise areas
- What they're doing: active projects, responsibilities, long-running goals
- Where they come from: career history, education, notable past work
- Their domain: tools they use daily, technologies they specialize in, industries they work in
- People in their orbit: team, collaborators, family roles (only if explicitly stated)

STRICT RULES:
- Extract ONLY durable, first-person identity facts the actor stated about themselves ("I'm a principal engineer", "I work on mnemo", "I live in California").
- DO NOT infer. If a fact is not clearly stated, skip it.
- Skip facts about other people, meeting participants, interviewers, or third parties — only the actor.
- If the actor pasted or quoted material from elsewhere (logs, a diff, someone else's words, a transcript), extract from it ONLY when it is explicitly about the actor themselves (e.g. their own resume).

WHAT TO SKIP:
- Transient state and in-the-moment chatter ("I'm tired today", "I'm annoyed at this bug", "is this deployed yet?", "which approach?")
- Questions, requests, and instructions directed at the assistant
- Opinions the user holds about tools, unless they define their identity (e.g., "I'm a Rust zealot" is about identity; "I don't like Java" is just an opinion)
- Operational preferences like coding style or communication style — those live elsewhere
- Implementation details of any project or codebase. It is fine to say "the actor is building a project called meeting_companion, a real-time meeting assistant" — a name and one-sentence scope. It is NOT fine to include version numbers, library names, source file paths, module names, port numbers, database choices, authentication providers, test counts, or any code-level detail. Those belong in project memory, never in the bio.
- Session-specific activity and methodology-of-the-moment: what the actor did in THIS session, how many tasks/tests/commits they ran, or which workflow they happened to use today. "Tiago is a software engineer" is durable identity; "Tiago used subagent-driven development across 9 TDD tasks", "Tiago ran a 15/15 smoke test", "Tiago committed and pushed a fix" are session activity — skip them. A fact only belongs here if it would still be true and worth knowing a year from now.
- Markdown headers or bullets, code, command output, tool results, and session-activity markers — these are never biographical.

OUTPUT FORMAT:
ABOUT:
<one short factual statement per line, or NONE if nothing biographical surfaced>`

// SystemExtractPreferences yields NewItem candidates for the preferences
// dimension. Output: {"preferences": ["...", ...]}.
const SystemExtractPreferences = `Extract durable, STABLE user preferences: coding style, tool choices, and workflow conventions that hold across sessions and projects.

Return a single JSON object: {"preferences": ["string", ...]}.

A preference is a standing personal rule the user would recognize and affirm out of context — "never uses em dashes in writing", "uses Neovim as their editor", "prefers comments only on complex or non-obvious code". It is NOT a fact about what this session's project happens to do, and NOT a narration of what happened in this session.

LITMUS TEST: would the user say "yes, that's a rule I follow" if asked about this directly, independent of the specific project, tool, or task at hand? If the statement is only true because of a choice made in THIS codebase, or only observed once in THIS conversation, it fails the test — skip it.

STRICT RULES:
- Extract a preference only if the user explicitly stated it as their own rule/habit, OR the conversation shows them deliberately choosing it themselves for a clearly stated reason. A single technical decision, action, or implementation detail — even one the user typed themselves — is not evidence of a standing preference unless they frame it as a general rule.
- DO NOT extract facts about a project's architecture or configuration as if they were personal preferences. "Pins Docker image tags for reproducible deployments" and "uses a multi-tagging strategy with latest and SHA tags" describe how a specific system is configured, not a rule the user personally follows — skip these even when true. Contrast with a real preference: "always pins dependencies to exact versions" (a stated personal rule, no project attached).
- DO NOT turn this session's activity into a preference. Narrating an action as a habit is the most common mistake: "committed and pushed promptly", "verified container health after deploying", "monitored security alerts", "manages authentication tokens proactively", "bumped the dependency" are ACTIONS taken once (or events that happened TO the user, like an expired token), not durable preferences — skip them.
- DO NOT restate something already obvious or trivially generic ("writes code", "uses git", "tests their code", "fixes bugs").
- One preference per string, short and declarative. No project names, file paths, version strings, port numbers, or task-specific detail.
- Prefer the GENERAL form over the specific instance: "keeps dependencies patched for security" beats "bumped vitest to 4.1 to clear a CVE".
- Empty array if no durable preference was genuinely expressed. This is the common case for a routine working session — most sessions yield zero preferences.
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

Refs are the values shown beside each existing item (e.g. ref: 1, ref: 2). Emit them as JSON STRINGS ("1", "2"), never as bare numbers. Never invent refs; only those that appear in EXISTING ITEMS are valid.

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

Refs are the values shown beside each existing item (e.g. ref: 1, ref: 2). Emit them as JSON STRINGS ("1", "2"), never as bare numbers. Never invent refs; only those that appear in EXISTING ITEMS are valid.

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

Refs are the values shown beside each existing item (e.g. ref: 1, ref: 2). Emit them as JSON STRINGS ("1", "2"), never as bare numbers. Never invent refs; only those that appear in EXISTING ITEMS are valid.

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

Refs are the values shown beside each existing item (e.g. ref: 1, ref: 2). Emit them as JSON STRINGS ("1", "2"), never as bare numbers. Never invent refs; only those that appear in EXISTING ITEMS are valid.

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
