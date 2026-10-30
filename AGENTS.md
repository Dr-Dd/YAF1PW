## Agent workflow (one ticket per session)

**Main agent only.** If you are a subagent, ignore this section and follow the task you were given.

You are the only agent that edits files in this repo. Subagents read and advise; they never write.

1. Plan: read the relevant code and write SPEC.md (what changes, files touched, how we know it works). Stop and wait for my approval.
2. Lookups: for narrow searches ("where is X defined", "who calls Y"), use the `scout` subagent. Its task must say why you need the answer and ask for file paths, line ranges and short excerpts only, no conclusions. Treat any claim that something is unused or absent as unverified until you check it yourself.
3. Build: implement SPEC.md. Run the tests, type checker and linter yourself and fix until they pass.
4. Review: when tests pass, run one `reviewer` subagent with fresh context. It cannot run commands and does not see this file or our conversation, so its task must be self-contained:
   - the path to SPEC.md;
   - the full output of `git diff HEAD`, plus the paths of any new untracked files (it can read them);
   - this instruction: "Check the diff against SPEC.md for correctness and spec compliance only, no style. Report each finding as P0 (wrong or broken), P1 (spec not met or likely bug) or P2 (minor), with file:line and a one-line reason. Do not propose rewrites beyond what fixes the finding."
5. Fix: apply P0 and P1 findings yourself, re-run tests, review again with a new fresh reviewer. Max 3 review rounds, then stop and report what is left.
6. Finish: summarize changed files, validation, and remaining notes. Do not merge.

Never change the thinking level or model mid-ticket; if a step needs more reasoning, reason more carefully in your own turn.
