---
name: token-efficient-work
description: Reduce avoidable context and tool-output costs during repository tasks while preserving correctness, required scope, and verification.
---

# Token-efficient repository work

Use this skill for coding, debugging, reviews, and implementation tasks where the context or tool output is becoming large. Optimize avoidable overhead; never skip required work or weaken security and correctness to save tokens.

## Before reading

- Identify the exact user outcome, repository, and applicable instructions first. Read `AGENTS.md` and any task-specific skill before editing.
- Check branch and working tree once. Preserve existing user changes; do not repeat broad status checks without a reason.
- Search with `rg` for relevant symbols and paths. Read only the matching files or narrow line ranges before opening whole files.
- For a large or multi-part task, split the work into concrete subsystems and track what has already been inspected so the same context is not reread.

## Tool calls and output

- Batch independent reads and checks into one tool call. Keep dependent operations sequential.
- Ask commands for concise output: summaries, changed paths, failing test names, and relevant error context. Avoid dumping full logs, lockfiles, generated bundles, or environment files into context.
- For long-running checks, redirect full logs to a task-local ignored file and inspect only a short tail or targeted matches. Never include secrets in captured output.
- Prefer focused tests for a local change, then run the repository's required final checks once. Repeat a check only after a relevant change or failure.
- When a command fails, inspect the specific cause and rerun only the affected step. Do not restart successful expensive checks without reason.

## Implementation and delegation

- Make the smallest coherent edit that fully meets the requested outcome. Reuse established project patterns and avoid unrelated cleanup.
- Delegate only when the user or applicable instructions call for it, or when parallel work is explicitly authorized. Avoid duplicated exploration.
- Do not make up metrics or token-cost breakdowns. If exact usage data is unavailable, describe the observed sources of overhead qualitatively.

## Reporting

- Report the result, key files, and verification evidence concisely. Separate completed local checks from external or device validation that remains pending.
- Mention material limitations and failures. Do not claim that a check passed unless its final run passed on the final relevant source.
- Keep detailed output in repository artifacts only when it helps review or reproduce the work; link to it instead of repeating it in the final response.

## Review checklist

- Did I read only the instructions and code needed for this task?
- Did I avoid oversized command output and repeated inspections?
- Did I run all required checks, without rerunning unrelated successful checks?
- Did I state what was verified and what remains unverified?
