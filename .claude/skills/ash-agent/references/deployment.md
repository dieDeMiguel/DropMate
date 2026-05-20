# Deployment Reference

Recommended posture:

1. develop locally
2. validate with build and checks
3. deploy to Vercel when you need shared durable hosting

## Common deployment flow

```bash
vercel login
vercel link
pnpm build
vercel
```

Production deploy:

```bash
vercel --prod
```

## Verify a deployment

- health route responds
- message route returns a `runId`
- run stream returns NDJSON lifecycle events
- any configured channel auth still succeeds in production

## Optional remote REPL

```bash
ash dev https://<deployment-url>
```
