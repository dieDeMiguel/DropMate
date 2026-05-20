import { defineInstrumentation } from "experimental-ash/instrumentation";
import { registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  recordInputs: true,
  recordOutputs: true,
  metadata: { "vercel.env": process.env.VERCEL_ENV ?? "" },
  setup: ({ agentName }) => registerOTel({ serviceName: agentName }),
});
