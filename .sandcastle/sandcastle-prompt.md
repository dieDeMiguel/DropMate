<commits>

!`git log -n 5 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found"`

</commits>

<inputs>

{{ INPUTS }}

</inputs>

# SANDCASTLE OVERLAY — single-issue scope + completion signal

The `<inputs>` block above is the GitHub issue number this iteration must work on. Treat it as your ONLY task:

- Do NOT scan `gh issue list` for alternatives.
- Do NOT pick a different issue, even if the input issue is already closed or invalid (in that case, comment on it and stop).
- Do NOT start a second issue after closing the first.

After you close the issue (or comment on it and decide to stop), emit EXACTLY this token on its own line as the LAST thing you output:

    <promise>NO MORE TASKS</promise>

Sandcastle watches for that token to exit cleanly. **Without it, sandcastle will spawn another iteration on already-shipped work** — burning Anthropic budget and risking spurious commits on a closed issue. This has happened before; the fix is to always emit the token when you're done.

Anything below this overlay is the host-loop prompt (`ralph/prompt.md`). Where its rules conflict with this overlay — most importantly its "only emit `NO MORE TASKS` when zero open issues exist" rule — **this overlay wins**.

---

!`cat ralph/prompt.md`
