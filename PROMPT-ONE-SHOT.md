# One-Shot Ticket Worker

You are an autonomous agent working on the prompt-eval project. Your job: pick up the highest-priority ticket, implement it, review it, commit it, and stop.

## Step 1: Bootstrap

```bash
lit quickstart
```

Then find work:

```bash
lit ls --query "status:open type:feature" --sort priority:asc,updated_at:asc --json
```

Pick the **first feature** (lowest priority number = most important). Skip epics.

Read the ticket:

```bash
lit show <ticket-id>
```

Claim it:

```bash
lit start <ticket-id> --reason "starting implementation"
```

## Step 2: Understand the Codebase

Read the key files before writing any code:

- `src/App.tsx` — Main app logic and state management
- `src/openai.ts` — API wrapper, models fetch, cost calculation
- `src/components/PromptPanel.tsx` — Column component
- `src/components/MarkdownOutput.tsx` — Markdown renderer
- `package.json` — Dependencies and scripts
- `index.html` — Entry point (relevant for CSP/meta tags)

The app is:
- Fully client-side React + TypeScript + Mantine UI
- No backend — API keys stay in the browser (sessionStorage)
- Vite-built, deployed to GitHub Pages
- OpenAI SDK used client-side with `dangerouslyAllowBrowser`

## Step 3: Implement (Subagent)

Launch a **Task subagent** (type: `general-purpose`) to implement the ticket. The subagent works directly in this repo (no worktrees). Give it:

1. The ticket title and full description
2. Which files to modify (based on your Step 2 analysis)
3. Specific architectural constraints (client-side only, Mantine UI, existing patterns)
4. What "done" looks like — concrete acceptance criteria

Wait for the subagent to finish.

## Step 4: Review (Subagent)

Launch a **second Task subagent** (type: `general-purpose`) to review the work. It should:

1. Read every file that was changed
2. Read `SPEC.md` and verify the implementation conforms to it
3. Check for:
   - Spec conformance: Does the implementation match the architecture, interfaces, and constraints defined in `SPEC.md`?
   - Correctness: Does it do what the ticket asks?
   - Security: No API key leaks, no XSS, no injection
   - Consistency: Matches existing code style and patterns
   - Completeness: No half-finished work, no TODOs left behind
   - Build: Run `npm run build` and verify it compiles clean
3. Produce a verdict: **PASS** or **CORRECTIONS NEEDED** with specific feedback

If the reviewer returns corrections, send the feedback to a new implementation subagent, then review again. Repeat until there is no more feedback.

## Step 5: Commit and Close

1. Stage only the files that were changed for this ticket (no `git add -A`)
2. Commit with a message referencing the ticket:
   ```
   <short description of what was done>

   Ticket: <ticket-id>
   ```
3. Do NOT push.
4. Close the ticket:
   ```bash
   lit done <ticket-id>
   ```

## Step 6: End

Report what you did:
- Which ticket you worked
- What files were changed
- The commit hash
- Any notes for the next agent

Do NOT pick up another ticket. Stop here.

---

## Rules

- **Never skip the review step.** Every implementation gets reviewed before commit.
- **Never push to remote.** Only commit locally.
- **Never modify files unrelated to the ticket.** Stay focused.
- **If the ticket is too large**, break it into smaller sub-tickets using `lit new` with `lit dep add`, then work the first sub-ticket only.
- **If you're blocked**, leave the ticket in_progress, comment with `lit comment <id> "blocked: <reason>"`, and stop.
- **Run `npm run build`** before committing to verify the build is clean.
