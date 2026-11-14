# Vercel API + a local LLM with no model fees

This guide deploys the existing web and NestJS API services to Vercel and runs model inference
on your own computer with Ollama. Ollama does not charge per token: your computer does the work.
This is not guaranteed to have zero total cost: electricity, internet, domain, and Vercel or
tunnel plan limits may apply. Keep the computer running and online while deployed assistants
need it.

## How requests travel

```text
Browser → Vercel web/API → Cloudflare Tunnel → local LiteLLM auth proxy → local Ollama → model
```

The API's `localhost` is a Vercel function, not your computer. The tunnel provides a reachable
HTTPS address. Ollama's local OpenAI-compatible API does not authenticate requests by itself, so
do not expose Ollama directly to the internet. This setup places LiteLLM in front of Ollama and
requires the bearer token configured as `LLM_API_KEY`.

The assistant uses the existing persisted-turn workflow: the API saves the completed answer and
the web client polls for it. It does not keep a Vercel request open for the entire model stream.

## 1. Prepare the local model machine

Install [Ollama](https://ollama.com/) and pull a model that fits your computer:

```powershell
ollama pull llama3.2
ollama run llama3.2
```

Confirm the Ollama server is available locally at `http://localhost:11434`. Keep it running.

Install LiteLLM on the same machine (Python 3.9 or later):

```powershell
python -m pip install 'litellm[proxy]'
```

Create `litellm-config.yaml` in a private local folder:

```yaml
model_list:
  - model_name: llama3.2
    litellm_params:
      model: ollama/llama3.2
      api_base: http://localhost:11434

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

Generate a long random key, then start the authenticated proxy. Keep the key private; set the
same value in LiteLLM and Vercel:

```powershell
$env:LITELLM_MASTER_KEY = "REPLACE_WITH_A_LONG_RANDOM_SECRET"
litellm --config .\litellm-config.yaml --host 127.0.0.1 --port 4000
```

In that PowerShell session, confirm the proxy requires the key and can reach Ollama:

```powershell
$headers = @{ Authorization = "Bearer $env:LITELLM_MASTER_KEY" }
Invoke-RestMethod -Uri http://localhost:4000/v1/models -Headers $headers
```

If you use a separate PowerShell session, set `$env:LITELLM_MASTER_KEY` there too before
running the verification command.

Do not bind LiteLLM or Ollama to `0.0.0.0`; Cloudflare Tunnel connects to the local loopback
port. The proxy key protects the model endpoint even though the public tunnel hostname is
reachable.

## 2. Create a Cloudflare Tunnel

Install `cloudflared`, sign in to Cloudflare, and create a named tunnel. Add a Public Hostname
for a domain you control, for example `llm.example.com`, routing to:

```text
http://localhost:4000
```

Start the tunnel and leave it running alongside Ollama and LiteLLM:

```powershell
cloudflared tunnel run YOUR_TUNNEL_NAME
```

Use the stable HTTPS hostname, not a changing Quick Tunnel URL. Keep Cloudflare Tunnel's
origin-targeted access restricted where practical, and monitor tunnel/proxy logs. The LiteLLM
bearer key is required regardless of tunnel access settings. Do not configure a Cloudflare
interactive-login policy on this API hostname unless your API can satisfy it; the server-to-server
request uses bearer authentication.

For a machine that sleeps, shuts down, or loses internet, model calls will fail until it is back
online. A free software tunnel does not make the machine highly available.

## 3. Configure Vercel

Use the repository's existing root `vercel.json` multi-service configuration:

1. In Vercel, import the repository with the **repository root** as the project root. Do not
   create separate Vercel projects for `apps/web` and `apps/api` for this setup.
2. Set the API service's production environment variables. Start from
   [vercel-production.env.example](../vercel-production.env.example) and follow
   [Vercel deployment setup](./deploy-vercel.md) for database, Redis, SMTP, and encryption keys.
3. Set the local-model variables on the API service:

   ```dotenv
   LLM_PROVIDER=local
   LLM_BASE_URL=https://llm.example.com/v1
   LLM_MODEL=llama3.2
   LLM_API_KEY=THE_SAME_LONG_RANDOM_SECRET_AS_LITELLM_MASTER_KEY
   LLM_TIMEOUT_MS=120000
   LLM_MAX_TOKENS=4096
   LLM_TEMPERATURE=0.7
   ```

4. Do not set `ANTHROPIC_API_KEY` unless you want Anthropic as a paid, explicitly selected
   provider. No silent fallback sends prompts elsewhere. Do not put Ollama's
   `http://localhost:11434` in Vercel: it would point back at the Vercel function.
5. Redeploy after setting environment variables.

Database, Redis, SMTP, and other production infrastructure can have their own charges. The LLM
itself runs on your machine, but Vercel functions still need a working database and Redis to serve
the application.

## 4. Verify end-to-end

1. On the model machine, keep Ollama, LiteLLM, and `cloudflared` running.
2. Check the proxy locally:

   ```powershell
   Invoke-RestMethod -Uri http://localhost:4000/v1/models `
     -Headers @{ Authorization = "Bearer $env:LITELLM_MASTER_KEY" }
   ```

3. Visit `https://YOUR_WEB_DOMAIN/api/health`. Confirm it reports database and Redis as up.
4. Sign in, open the assistants, and send a short test in English and Arabic. Confirm the
   completed response appears in the conversation.
5. Check `https://YOUR_WEB_DOMAIN/api/assistants/health` while signed in. It reports whether the
   configured local model server can be reached.
6. Temporarily stop LiteLLM and submit another test. The assistant should return a friendly
   localized unavailable message; restart the proxy afterwards.

The health endpoint verifies endpoint reachability; it does not guarantee that the model is
loaded, has enough memory, or can answer within the configured timeout.

## Security and cost checklist

- Never expose port `11434` (Ollama) directly to the public internet.
- Use a unique random `LITELLM_MASTER_KEY` and the same value as Vercel's `LLM_API_KEY`. Store
  the Vercel value only in Vercel's encrypted environment settings, not in Git or a committed
  `.env` file.
- Keep both LiteLLM and the tunnel bound to the local machine; do not bind the proxy to all
  network interfaces.
- Rotate the key in both places if it is exposed, then redeploy the API.
- Use only data you are permitted to send to this machine. A tunnel encrypts transport but does
  not change your data-retention or privacy responsibilities.
- There is no model-provider token bill in this setup. Electricity, internet, hardware, a domain,
  optional Cloudflare features, and Vercel resource/plan limits can still cost money. Check each
  provider's current terms and quotas before relying on a free tier.

For troubleshooting or a non-local/private model host, see [Local LLM setup](./LOCAL-LLM.md) and
[Vercel deployment](./deploy-vercel.md).
