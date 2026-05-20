import { defineInstrumentation } from "experimental-ash/instrumentation";

export default defineInstrumentation({
  recordInputs: true,
  recordOutputs: true,
  metadata: { "vercel.env": process.env.VERCEL_ENV ?? "" },
});
