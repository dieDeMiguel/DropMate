# Project Layout Reference

Recommended layout:

```text
my-agent/
├── package.json
├── tsconfig.json
└── agent/
    ├── agent.ts
    ├── instructions.md
    ├── skills/
    ├── lib/
    ├── sandbox/
    ├── tools/
    ├── channels/
    ├── schedules/
    └── subagents/
```

## Slot guide

- `instructions.md` - base instructions prompt (the legacy `system.md` slot still works with a deprecation warning)
- `skills/` - on-demand procedures
- `tools/` - typed executable integrations
- `channels/` - HTTP or messaging entrypoints; `onDeliver()` writes durable context and static
  `contextProviders` rebuild live step-local values when needed; Slack channels can override
  `handleInteraction(...)` for no-wake UI actions
- `sandbox/` - the agent's single sandbox; optional `sandbox.ts` override and optional
  `workspace/` seed files
- `subagents/` - specialist child agents (each carries its own independent `sandbox/`)
- `schedules/` - recurring jobs
- `agent.ts` - additive runtime config for model, name, metadata, build, compaction, and workspace

Prefer the nested `agent/` layout for new apps.
