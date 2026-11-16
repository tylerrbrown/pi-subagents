/**
 * Helper (subagent) session names: `<Parent subject> - <Role> <task intent>#<id8>`,
 * e.g. `Inbox - Tester Quarantine Release Regression#61f471ad`.
 *
 * The parent subject is the left side of the parent's `<Subject> - <Detail>`
 * title (rule 070). The detail is the Role plus intent words from the first
 * plain prompt line, kept within the 3-6 word detail budget. When there is no
 * usable parent name or too little intent, the old `<Role>[#id8]` form is used.
 */

const DELIMITER = " - ";
const MAX_DETAIL_WORDS = 6;
const MIN_DETAIL_WORDS = 3;
const MAX_SUBJECT_WORDS = 4;

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "with", "this", "that", "these", "those",
  "please", "you", "your", "we", "our", "is", "are", "be", "it", "its", "at", "by", "from", "as", "into",
  "then", "so", "all", "any", "do", "can", "will", "should", "must", "i", "me", "my",
]);

function legacyName(base: string, agentId?: string): string {
  return agentId ? `${base}#${agentId.slice(0, 8)}` : base;
}

function titleWord(word: string): string {
  return word.split("-").map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part)).join("-");
}

/** Left side of `<Subject> - <Detail>`, or the whole name when it is a short plain subject. */
export function parentSubject(parentName: string | undefined): string | undefined {
  const name = parentName?.trim();
  if (!name) return undefined;
  const idx = name.indexOf(DELIMITER);
  const subject = (idx >= 0 ? name.slice(0, idx) : name).trim();
  if (!subject || /[#\\/:]/.test(subject)) return undefined;
  if (subject.split(/\s+/).length > MAX_SUBJECT_WORDS) return undefined;
  return subject;
}

/** A line that is only a file path (optionally quoted, backticked, or prefixed with `Read`). */
function isPathOnly(line: string): boolean {
  const bare = line.replace(/^read\s+/i, "").replace(/^[`"'<[(]+|[`"'>\])]+$/g, "").trim();
  if (!bare) return false;
  if (!/\s/.test(bare)) return /[\\/]/.test(bare) || /\.[A-Za-z0-9]{1,6}$/.test(bare);
  // Rooted paths with spaces in folder names, ending in a file extension.
  return /^([A-Za-z]:[\\/]|\/|~[\\/]|\.{1,2}[\\/]).*\.[A-Za-z0-9]{1,6}$/.test(bare);
}

/** Intent words from the first plain prompt line, Title Cased, at most `max` words. */
export function intentWords(prompt: string, max: number): string[] {
  for (const raw of prompt.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, "").trim();
    if (!line || isPathOnly(line) || /^<[^>]*>$/.test(line)) continue;
    const words = line
      .split(/\s+/)
      .filter((token) => !/[\\/]/.test(token)) // drop inline paths and URLs
      .map((token) => token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ""))
      .filter((token) => /^[A-Za-z0-9][A-Za-z0-9'-]*$/.test(token))
      .filter((token) => !STOPWORDS.has(token.toLowerCase()));
    return words.slice(0, max).map(titleWord);
  }
  return [];
}

export function composeHelperSessionName(input: {
  parentName?: string;
  role: string;
  prompt: string;
  agentId?: string;
}): string {
  const subject = parentSubject(input.parentName);
  if (!subject) return legacyName(input.role, input.agentId);
  const role = titleWord(input.role);
  const intent = intentWords(input.prompt, MAX_DETAIL_WORDS - 1);
  if (intent.length + 1 < MIN_DETAIL_WORDS) return legacyName(input.role, input.agentId);
  return legacyName(`${subject}${DELIMITER}${[role, ...intent].join(" ")}`, input.agentId);
}
