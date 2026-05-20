---
name: ash-agent
description: Public Ash guide for app authors. Use when building Ash apps, writing user-facing docs/examples, explaining project layout, or helping someone deploy and operate an Ash project. Prefer authored-file guidance, minimal examples, and end-user implementation details.
metadata:
  author: Ash repo
  version: "0.0.1"
---

# Ash App Author Guide

Use this skill for end-user Ash work.

## When to use this skill

Use this skill when the task is about how an app author uses Ash, including:

- building an Ash app
- writing or updating public docs and examples
- explaining agent layout and authoring slots
- teaching how skills, tools, the sandbox, channels, or subagents fit together
- showing how to install Ash from npm and get started locally
- helping someone deploy or operate an Ash app

If the task is mainly about Ash internals, compiler behavior, runtime plumbing, or implementation
constraints, load the `ash-framework` skill instead.

## How to use this skill

1. Start from the app author's point of view.
2. Read the bundled references before relying on memory.
3. Use the scripts in `scripts/` when they match the user's goal.
4. Keep guidance task-oriented, concrete, and minimal.

## Writing or updating public docs

The docs website at `apps/docs` renders two directories directly:

- `/docs/public` — polished public docs, manually ordered via
  `/docs/public/meta.json`.
- `/research/active` — active design notes, mounted under `/docs/research`
  and listed alphabetically with no meta.json.

Every markdown file in either directory that should render on the site
**must** have this shape:

```md
---
title: "Short page title"
description: "One-sentence summary of the page."
url: /custom/site/path # optional, /docs/public only; only if filename ≠ site URL
---

Body starts here. Do NOT repeat the title as an `# H1` in the body — the
site renders the frontmatter `title` as the page heading.
```

After creating a new `/docs/public` page:

- Add its slug to `/docs/public/meta.json#pages` in the section that matches
  its topic. The slug is the filename without the `.md` extension for root
  files, or the folder name for subfolder groups. The trailing `"..."` token
  auto-includes anything missing but gets placed at the bottom — put new
  pages in the intended position explicitly.

New `/research/active` files need no meta.json work — the Research section
sorts alphabetically.

Files intentionally excluded from the site (the top-level `README.md` in
each directory, etc.) should have no frontmatter and be listed in the
EXCLUDES set of `scripts/check-docs.mjs`. `pnpm docs:check` validates every
other file in both directories.

## What Ash is

Ash is a filesystem-first framework for durable backend agents.
Authors define agents on disk with files like `instructions.md`, `skills/`, `tools/`, `sandbox/`,
`channels/`, `subagents/`, `schedules/`, and `agent.ts`.

## Core behavior to reinforce

- `instructions.md` is the always-on instructions prompt.
- `skills/` are on-demand procedures loaded only when relevant.
- `tools/` are typed executable integrations.
- each agent has exactly one sandbox; the workspace is the filesystem inside it.
- `sandbox/sandbox.ts` overrides the sandbox definition and `sandbox/workspace/` seeds files; both
  are optional and the framework supplies a default.
- `channels/` are authored messaging-platform entrypoints and can seed durable context in
  `onDeliver()`.
- `getSession()`, `getSandbox()`, and `getSkill()` are public authored runtime helpers.
- `getContext()`, `requireContext()`, `hasContext()`, `setContext()`, and `ensureContext()` are the
  public unified context helpers.
- channel classes can declare `static readonly contextProviders = [...]` to derive live step-local
  values from durable context.
- `SlackChannel` subclasses can override `handleInteraction(ctx, interaction)` for no-wake Slack UI
  actions, use `getSlackThread()` for thread reads/posts, and call `editMessage(messageTs, renderable)`
  to update Slack messages inline.
- `subagents/` are specialist child agents with separate runs.
- `schedules/` are recurring triggers.
- `agent.ts` is where model, name, metadata, build, compaction, and workspace preferences live.
- route auth and IP policy live on the HTTP channel layer, not in `agent.ts`.

## Preferred workflow

Read these bundled references in roughly this order:

1. `references/getting-started.md`
2. `references/project-layout.md`
3. `references/skills.md`
4. `references/runtime-model.md`
5. `references/deployment.md`

## How to explain Ash well

- lead with how to use Ash, not how Ash is implemented
- start with the authored filesystem shape and the smallest working path
- explain when to use each authored slot and show the file path where it lives
- use one minimal example before edge cases
- explain that skills are discovered first and loaded through the framework-owned `load_skill` tool
- explain current boundaries such as root-only `schedules/` when relevant
- mention the package name is `experimental-ash` while the framework and CLI are called Ash and `ash`
- note that route auth lives on channels and that `agent.ts` no longer owns it
- for Slack or custom channel examples, explain the two-step context pattern: `onDeliver()` writes
  durable keys, then `static readonly contextProviders = [...]` rebuilds live per-step values
- for Slack UI interactions, explain that `handleInteraction(ctx, interaction)` is the subclass hook
  for no-wake `block_actions`, `editMessage(messageTs, renderable)` edits messages inline,
  `getSlackThread()` exposes thread reads/posts, and `SlackRenderable` is the authored output format
- point people to packaged references instead of assuming repo docs are available

Prefer feature-first framing like:

- "Use a tool when you need typed executable logic."
- "Use a sandbox when the model needs an isolated shell environment."
- "Use a skill when you want optional procedure guidance without bloating every turn."

Avoid starting with compiler, discovery, runtime, or harness internals unless the task truly requires them.

## Bundled scripts

Use these packaged scripts when helpful:

- `scripts/bootstrap-from-npm.sh` - scaffold a new Ash app from npm
- `scripts/add-to-existing-project.sh` - add Ash to an existing app
- `scripts/verify-local-agent.sh` - reminder of the common local verification commands

## Build, dev, and deployment expectations

- `ash info` validates the authored surface and inspects the resolved app contract.
- `ash build` compiles artifacts and builds the runtime host output.
- `ash dev` runs the local host and interactive REPL.
- stable runtime routes include `GET /.well-known/ash/v1/health`, `POST /.well-known/ash/v1/message`, and `GET /.well-known/ash/v1/runs/:runId/stream`
- channel webhooks follow `POST /.well-known/ash/v1/channels/<channelId>/webhook` when channels are configured
- recommend local development first, then Vercel deployment when shared durable hosting matters

## Supporting skills

When public Ash work touches adjacent systems, also load the relevant specialist skills:

- `ash-framework` for compiler, runtime, discovery, or artifact internals
- `ai-sdk` for AI SDK APIs, tool calling, and provider integration details
- `workflow` for durable orchestration behavior and step-boundary decisions

For deployment-heavy tasks, it can also help to install Vercel-maintained skills with `npx skills`
so the agent can pull in current deployment guidance.

## Completion checklist

- keep the answer user-facing and task-oriented
- if public behavior changes, update public docs too
- prefer packaged references and scripts over repo-only links
- run the expected quality gates before considering the work done
- ensure public API changes are documented and covered by tests
