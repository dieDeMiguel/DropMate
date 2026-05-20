# Getting Started Reference

Ash is a filesystem-first framework for durable backend agents.

## Install from npm

The framework is called Ash, but the current npm package name is `experimental-ash`.

Common install paths:

```bash
pnpm dlx experimental-ash@latest init my-agent
cd my-agent
pnpm install
pnpm dev
```

Add Ash to an existing app:

```bash
pnpm add -D experimental-ash
```

## Smallest working path

1. scaffold or create a project
2. add `agent/instructions.md`
3. add `agent/agent.ts`
4. add one tool if runtime behavior is needed
5. run `pnpm dev`

## Important naming note

- framework name: Ash
- npm package name: `experimental-ash`
- CLI name: `ash`
