package extract

// SystemProjectTaskDailyLog is ported verbatim from buildExtractionPrompt in
// infra/lambda/context-extractor/index.ts (lines 67-94).
//
// The static template body is preserved exactly. Three runtime values are
// injected via fmt.Sprintf:
//   %s[0] — domain list (one "   - <domain>" entry per line)
//   %s[1] — optional known-context block (empty string when no metadata)
//
// Usage: fmt.Sprintf(SystemProjectTaskDailyLog, metaSection, domainList)
const SystemProjectTaskDailyLog = `You are analyzing a conversation to extract durable knowledge — things a future session would benefit from knowing.
%s
1. CLASSIFY THE TASK DOMAIN: Pick exactly one:
%s
   If unclear, use "general". If too short to classify, output "unknown".

2. EXTRACT KEY INSIGHTS: Distill the conversation into facts that will still be relevant weeks from now. Focus on the "why" behind decisions, not the "what" of implementation steps. A good fact reads like a design doc, not a commit log. If nothing is worth remembering long-term, output NONE.

3. WRITE A DAILY LOG ENTRY: A detailed paragraph covering what was worked on, decisions made, problems encountered and how they were resolved, tools and technologies used, and any notable learnings. Be comprehensive — this will be consolidated into a daily digest later. Write 3-8 sentences.

Respond in this exact format:
TASK: <task_domain>
FACTS:
<one fact per line, or NONE if nothing meaningful>
DAILY:
<3-8 sentence detailed log entry, or NONE if nothing meaningful>`

// SystemAbout is the biographical extractor. Ported verbatim from
// buildAboutPrompt in infra/lambda/context-extractor/index.ts (lines 824-850).
const SystemAbout = `You are extracting biographical facts about the person (the "actor") who is participating in this conversation.

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

// SystemAboutConsolidate is the about consolidation prompt. Always runs, even
// on first write, to enforce the narrative-paragraph shape. Ported verbatim
// from the "about" branch of buildConsolidationPrompt in
// infra/lambda/context-extractor/index.ts (lines 307-329).
//
// The record limit (16000) replaces ${AGENTCORE_RECORD_LIMIT}.
// Two runtime values are injected via fmt.Sprintf:
//   %s[0] — existing bio text (or "(none yet)")
//   %s[1] — new observations to incorporate
//
// Usage: fmt.Sprintf(SystemAboutConsolidate, existingText, newContent)
const SystemAboutConsolidate = `You are maintaining a living biographical profile of a person, updated over time as new information surfaces about them.

This is an ABOUT memory — who the actor is as a person: background, role, expertise, ongoing interests, identity attributes. Think of it as a short "About" section on someone's personal site.

Rules:
- Write as ONE flowing narrative paragraph (or two short paragraphs if needed). NOT a bullet list.
- Open with the person's name if it is known from the existing bio or the new observations. If no name has ever been stated, refer to them as "the actor" (lowercase, no quotes) and do NOT invent one.
- Merge the new information with the existing bio. Drop outdated or contradicted facts — keep the most recent version.
- Biographical scope only. Project names and one-sentence scope are fine ("she is building a real-time meeting assistant called meeting_companion"). Do NOT include library versions, source file paths, module names, port numbers, database choices, authentication providers, test counts, or any code-level detail. If the existing bio contains such details, strip them out. Those belong in project memory, never in the bio.
- Stay under ~800 words. A good bio is dense and specific.
- Do not invent facts. Only include what the existing bio or new observations clearly establish.
- Write in third person for consistency.
- HARD LIMIT: output must be under 16000 characters.

EXISTING BIO:
%s

NEW OBSERVATIONS TO INCORPORATE:
%s

Output ONLY the merged bio text — no headers, labels, or explanations.`

// SystemProjectTaskConsolidate is the shared consolidation prompt for project
// and task dimensions. Ported verbatim from the project/task branch of
// buildConsolidationPrompt in infra/lambda/context-extractor/index.ts
// (lines 331-353).
//
// The record limit (16000) replaces ${AGENTCORE_RECORD_LIMIT}.
// Three runtime values are injected via fmt.Sprintf:
//   %s[0] — type instructions (project-specific or task-specific paragraph)
//   %s[1] — existing records text
//   %s[2] — new information to incorporate
//
// Usage: fmt.Sprintf(SystemProjectTaskConsolidate, typeInstructions, existingText, newContent)
const SystemProjectTaskConsolidate = `You are consolidating memory records into a single distilled record that supersedes all inputs.

%s

Rules:
- Merge overlapping statements — keep only the most complete version of each fact
- When facts conflict, keep the most recent version
- Write concisely — a good record reads like a design doc, not a changelog
- Drop anything that won't be useful in a future session
- HARD LIMIT: output must be under 16000 characters. Prioritize the most important facts and cut aggressively if needed

EXISTING RECORDS:
%s

NEW INFORMATION TO INCORPORATE:
%s

Output ONLY the merged content — no headers, labels, or explanations.`

// SystemPreferences is net-new for the Go rewrite. AgentCore handled this as a
// built-in strategy in the AWS version.
const SystemPreferences = `Extract durable user preferences from this conversation: coding style, tool choices, workflow conventions.

Return a single JSON object: {"preferences": ["string", ...]}.

Rules:
- Only durable preferences a user has stated (or strongly implied), not one-off requests.
- Skip code snippets, file paths, version strings, port numbers.
- Prefer short declarative statements: "prefers tabs over spaces", "uses Go for backend services".
- Empty array if no preferences were expressed.
- Output JSON only. No prose, no code fences.`

// SystemEpisodes: net-new for the rewrite. Extracts discrete event+reflection
// pairs. Facts as a separate dimension was dropped — biographical facts go to
// `about`, project facts to `project`, task-domain facts to `task`.
const SystemEpisodes = `Extract structured episodes from this conversation.

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

// SystemFreshnessConsolidate is the freshness-aware consolidation prompt for
// preferences and facts. Like SystemAboutConsolidate / SystemProjectTaskConsolidate,
// it's sent as a single user message via fmt.Sprintf. Placeholders, in order:
//
//	%s[0] — dimension label (e.g. "preferences", "facts")
//	%s[1] — today's date (YYYY-MM-DD, UTC)
//	%s[2] — existing record's last_updated timestamp (YYYY-MM-DD), or "(n/a)"
//	%s[3] — existing record body (the prior consolidated content), or "(none yet)"
//	%s[4] — newly-extracted content from THIS conversation
//
// Usage: fmt.Sprintf(SystemFreshnessConsolidate, dim, today, existingDate, existingText, newContent)
//
// TODO(tiago): the RULES block below is intentionally a placeholder.
// What should the LLM actually do with stale / contradictory / reinforced items?
// Fill in 5-8 numbered rules describing your desired behavior. See the comment
// block above the rules for the levers you have.
const SystemFreshnessConsolidate = `You are maintaining a long-lived %s record for a personal memory system.

The record is a single document you rewrite from scratch each time. You can think of it as a markdown file that has been edited over months. Older entries linger unless you actively prune them; freshly-reinforced entries should be promoted; contradictions should be resolved in favor of the most recent statement.

CONTEXT:
- Today's date: %s
- Existing record was last updated: %s
- The existing record's content follows.
- After that, the new content to incorporate follows.

RULES:
1. Each entry is a single markdown bullet on its own line, starting with "- ".
2. Every bullet ends with a date marker "(YYYY-MM-DD)" indicating the last date the fact was reinforced.
3. When the new content reinforces an existing bullet — even paraphrased — bump that bullet's date to today and keep the more concise phrasing.
4. When the new content contradicts an existing bullet, drop the existing bullet silently (no audit trail) and add the new statement as a fresh bullet with today's date.
5. When the new content introduces a fact not present in the existing record, add it as a new bullet with today's date.
6. Drop any bullet whose date is more than 12 months older than today AND not reinforced today.
7. Keep bullets concise — one line, no sub-bullets, no headers, no sections, no introductory text.
8. Output ONLY the full updated record. No preamble, no explanation. Empty output is valid if every bullet should be dropped.

EXISTING RECORD:
%s

NEW CONTENT TO INCORPORATE:
%s

Output ONLY the merged record — no preamble, no explanation.`

