# Skills Reference

Skills are Ash's on-demand procedure layer.

## How skills work

1. Ash discovers skills under `skills/`.
2. The runtime advertises available skills to the model.
3. The runtime provides a framework-owned `load_skill` tool.
4. When the model activates a skill, that skill's instructions join the active turn context.

## Rules that matter

- flat skills can be simple markdown files under `skills/*.md`
- packaged skills live under `skills/<name>/SKILL.md`
- packaged `SKILL.md` files must include `name` and `description`
- tools remain visible whether or not a skill is activated
- the legacy `allowed-tools` field is not supported
- skills are loaded through the framework-owned `load_skill` tool

## When to use a skill

Use a skill for optional procedures, call-routing guidance, and repeatable workflows that should not
inflate every turn.

Do not use a skill for always-on identity or typed execution.
