/**
 * Standardized prompts for Git commit message generation.
 */
export const COMMIT_MESSAGE_PROMPT = `### 2) Commit Message Style (Required)
Commit messages must be:

**Format**
- A clear subject line (Conventional Commit style preferred):
  - \`feat: ...\`
  - \`fix: ...\`
  - \`chore: ...\`
  - \`docs: ...\`
  - \`refactor: ...\`
  - \`test: ...\`
  - \`perf: ...\`
  - \`ci: ...\`
  - \`build: ...\`
- Emojis are encouraged in the subject line and/or bullets where fitting.

**Body**
- The body must be grouped by category, each as a heading + bullet list.
- Each bullet is **1–2 sentences max** and describes what changed and what it affects.

**Example body structure**
- **✨ Features**
  - Add X to Y so users can Z.
- **🐛 Fixes**
  - Prevent crash when A is missing by validating B.
- **🧹 Chores**
  - Update deps and remove unused config to keep builds tidy.

If only one category applies, include only that category.`;

/**
 * System prompt for the commit message generator.
 */
export const COMMIT_SYSTEM_PROMPT = `You are an expert at writing conventional commit messages based on git diffs.
Follow the user's requested style and format strictly.
Return ONLY the commit message text.`;
