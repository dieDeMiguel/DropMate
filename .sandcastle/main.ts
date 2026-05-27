import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const [, , planAndPrd, maxIterations] = process.argv;

await run({
  sandbox: docker(),
  agent: claudeCode("claude-sonnet-4-6"),
  promptFile: `.sandcastle/sandcastle-prompt.md`,
  maxIterations: Number(maxIterations) ?? 3,
  promptArgs: {
    INPUTS: planAndPrd,
  },
  hooks: {
    onSandboxReady: [{ command: "pnpm install" }],
  },
  completionSignal: "<promise>NO MORE TASKS</promise>",
});
