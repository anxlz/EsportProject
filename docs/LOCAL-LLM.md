# Local LLM for personal assistants

The assistants keep their existing prompts, user-scoped read-only tools, proposal review steps,
and persisted conversation workflow. The local adapter speaks the OpenAI-compatible
`/v1/chat/completions` API and consumes its SSE token stream; completed assistant turns continue
to be persisted and fetched by the web app. That polling workflow is deliberate: requests can run
on separate API instances and must not depend on process-local streaming state.

## Local development

1. Install Ollama and pull a model, for example `ollama pull llama3.2`, or start the optional
   `ollama` service documented in the root `docker-compose.yml`.
2. Set these values in `apps/api/.env`:

   ```dotenv
   LLM_PROVIDER=local
   LLM_BASE_URL=http://localhost:11434/v1
   LLM_MODEL=llama3.2
   LLM_API_KEY=
   ```

3. Restart the API. `GET /api/assistants/health` reports whether the selected local endpoint is
   reachable. A model server that is stopped or times out produces a translated Arabic/English
   assistant error; it does not crash the API.

The server validates `LLM_BASE_URL`, `LLM_MODEL`, optional `LLM_API_KEY`, timeout (500–600,000
ms), maximum output tokens (1–32,768), and temperature (0–2). No prompts or personal data are
written to logs; only model, token counts, and request latency are logged.

## Deployment

`localhost` means the API host, not a user's browser or developer machine. A Vercel API therefore
cannot reach an Ollama instance running on a laptop. To keep model usage free, you can leave
Ollama running on your own always-on machine and expose it through a secured tunnel; set the
Vercel `LLM_BASE_URL` to that tunnel's HTTPS `/v1` URL. The machine must stay online, and the
tunnel must require authentication. Alternatively, use a private model host (for example an
AWS-hosted Ollama server). In either case, configure `LLM_API_KEY` or a strict network/IP
allowlist, and do not expose an unauthenticated model server publicly. The model itself has no
per-token provider charge, but the machine, network, and any hosting/tunnel plan may have costs.

Set these variables in Vercel's project environment for the API deployment:

```dotenv
LLM_PROVIDER=local
LLM_BASE_URL=https://your-secured-model-host.example/v1
LLM_MODEL=llama3.2
LLM_API_KEY=your-model-server-key
```

Keep local development's `LLM_BASE_URL=http://localhost:11434/v1` in `apps/api/.env`; use the
reachable HTTPS address only in Vercel. The API can use the existing persisted turn/polling
workflow on both environments, so model generation does not require holding an HTTP response open
for Vercel's full execution window.

Provider selection order is: per-feature `AI_PROVIDER_OVERRIDES`, explicit `LLM_PROVIDER`,
legacy `AI_PROVIDER_DEFAULT`, then Anthropic when `ANTHROPIC_API_KEY` is set, otherwise local.
The existing Qwen provider and its explicit routes remain supported. There is no silent fallback
that sends assistant data to a different provider.
