# Voice Agent Requirements Generator

Enter a client's website URL, and optionally upload a sample document. The app reads the relevant public pages and produces a tailored **voice-agent** or **voicemail** script as an **Audio Recordings Catalog**:
- **Numbered sections.** Voice agent: Opening, Qualifying Questions, Transfer/Closing, Resume Questions, Flow Edge Questions, Edge Questions, Global Exits, Silence Prompts, Extra Questions. Voicemail uses a shorter set.
- **One table row per recorded clip,** with a file name and transcript in each language and an expected-answer note.
- **Unspoken routing rules** ("Suite — … / Routing — …") after each section.

Scripts can be **bilingual**. The primary language defaults to the website's language, with an English second column, matching the reference `Kiloweo_V1_Simple_FR_EN` layout. You can preview and edit the catalog, then download it as **DOCX**. The app also produces a separate **Claude-ready prompt**.

Facts that aren't on the website are never invented. Each one becomes a highlighted `[TO CONFIRM: …]` placeholder and is listed under **Missing information**.

## Setup

Requirements: Node.js 24+, npm 11+.

```bash
npm install
cp .env.example .env      # then set OPENROUTER_API_KEY locally (never commit .env)
npm run dev               # API on http://localhost:8787, UI on http://localhost:5173
```

If `OPENROUTER_API_KEY` is not set, the server runs in **mock mode**: the full flow (crawl, preview/edit, DOCX, Claude prompt) works, but the document is a clearly labelled skeleton instead of AI output.

| Script | What it does |
| --- | --- |
| `npm run dev` | Runs the server (tsx watch) and client (Vite, proxies `/api`) together |
| `npm run build` | Compiles the server to `server/dist` and builds the client to `client/dist` |
| `npm start` | Runs the built server, which also serves the built client on one port |
| `npm run typecheck` | Type-checks both workspaces |
| `npm test` | Runs the server test suite (Vitest + Supertest) |

### Environment variables

See [.env.example](.env.example). All secrets stay on the server. The browser never receives the API key or the master prompt.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | (unset → mock mode) | OpenRouter API key |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-5.5` | Any OpenRouter model slug; check the exact slug on openrouter.ai/models |
| `PORT` | `8787` | HTTP port |
| `MAX_UPLOAD_MB` | `5` | Sample upload size limit |
| `MAX_PAGES` | `8` | Max website pages analysed (homepage + most relevant links) |
| `RATE_LIMIT_PER_MIN` | `10` | `/api/generate` requests per minute per IP |
| `TRUST_PROXY` | `false` | Set (e.g. `1`) behind a reverse proxy so rate limiting sees real client IPs |
| `FETCH_TIMEOUT_MS` | `10000` | Per-page website fetch timeout |
| `LLM_TIMEOUT_MS` | `180000` | AI request timeout |
| `STATIC_DIR` | `client/dist` | Location of the built client |

## Usage

1. Enter the client's website (e.g. `example.com`), choose **Voice agent** or **Voicemail**, then pick the script language ("Same as website" by default) and the optional second-language column (English by default; "None" gives a single-language script).
2. Optionally attach a sample (`.docx`, `.pdf`, `.txt`, `.md`). It is used as a style and structure reference only, never as a template or a source of facts.
3. Click **Generate**. Then review the **Missing information** panel, switch to **Edit** to change clips, file names and routing rules, and use **Download DOCX**.
4. After editing, click **Update prompt** to rebuild the Claude-ready prompt, then copy it or download it as `.md`.

## Architecture

```
client/ (React + Vite + TS)                 server/ (Express 5 + TS)
  GeneratorForm ─┐                            routes/api.ts
  DocumentView   ├── /api/generate ────────▶   ├─ security/url.ts      URL validation + SSRF policy
  SidePanels     ├── /api/export/docx          ├─ services/fetcher.ts  pinned-DNS safe fetch, redirects, limits
                 └── /api/claude-prompt        ├─ services/extractor.ts Cheerio text + relevant-page crawl
                                               ├─ services/upload.ts   in-memory upload, signature check, parsing
                                               ├─ prompts/master.ts    PREDEFINED master prompt
                                               ├─ services/openrouter.ts  LLM call, JSON validation, 1 retry
                                               │  services/mockGenerator.ts (no key)
                                               ├─ services/document.ts assemble/normalise document
                                               ├─ services/docx.ts     DOCX rendering
                                               └─ services/claudePrompt.ts
```

**Generation pipeline:**
1. Validate the URL.
2. Parse the sample, if one was uploaded.
3. Crawl the homepage plus the top-ranked same-site pages (contact, hours, services, FAQ, booking…). Each page is capped at 8k characters and the total at 40k.
4. Send the master prompt and the fenced, untrusted content to the LLM, which returns strict JSON. This is validated with zod and retried once if it's invalid.
5. Normalise the result into the fixed catalog sections, turning clip names into unique snake_case file names. Sources the model cites but that weren't crawled are dropped.
6. Build the Claude prompt from the final document.

### API

| Method & path | Body | Response |
| --- | --- | --- |
| `GET /api/health` | — | `{ status, mock, maxUploadMb }` |
| `POST /api/generate` | multipart: `url`, `mode` (`voice-agent`\|`voicemail`), optional `sample` file | `{ document, claudePrompt, crawl, sampleUsed, mock }` |
| `POST /api/export/docx` | document JSON | `.docx` file |
| `POST /api/claude-prompt` | document JSON | `{ claudePrompt }` |

Errors are always `{ error: { code, message } }` with a safe message. Stack traces and provider details are only logged on the server.

## Security

- **SSRF protection** ([server/src/security/url.ts](server/src/security/url.ts), [server/src/services/fetcher.ts](server/src/services/fetcher.ts)):
  - Only `http`/`https` URLs on ports 80/443 are allowed, with no embedded credentials.
  - `localhost`, `*.local` and `*.internal` names, and single-label hostnames, are rejected.
  - IP literals are canonicalised (decimal, hex and octal forms are caught), then checked against private, loopback, link-local, CGNAT, metadata, multicast and IPv6 ULA/link-local/mapped/NAT64/6to4/Teredo ranges.
  - DNS is resolved at connect time. If **any** resolved address is non-public the request is refused, and the socket is pinned to the validated address to prevent DNS rebinding.
  - Redirects are followed manually (max 3), and every hop is validated again.
  - 10 s timeout, a 2 MB cap applied to the **decompressed** response (blocks compression bombs), and HTML content types only.
- **Uploads** ([server/src/services/upload.ts](server/src/services/upload.ts)):
  - Files are held in memory only and never written to disk. One file per request, with a size limit.
  - Only `.docx`, `.pdf`, `.txt` and `.md` extensions are accepted.
  - The file signature is checked: `%PDF-` for PDF, a ZIP header containing `word/document.xml` for DOCX, and valid UTF-8 with no NUL bytes for text.
  - Parsing times out after 15 s, and extracted text is capped at 20k characters.
- **Prompt injection:**
  - Website and sample text are wrapped in delimited blocks marked as untrusted, and tag look-alikes inside them are escaped.
  - The master prompt tells the model to ignore any instructions found in that content.
  - Model output is schema-validated, and cited sources are checked against the pages that were actually crawled.
- **HTTP hardening:**
  - Helmet security headers, with `x-powered-by` disabled.
  - JSON body limit of 1 MB, and a per-IP rate limit on generation.
  - The API key is read only from the server environment.
- **Dependencies:** an npm `overrides` entry gives `mammoth` `argparse` 2 instead of 1.x, removing the vulnerable `sprintf-js`. `argparse` is used only by mammoth's CLI.

## Testing

`npm test` runs 135 tests:
- **URL/SSRF policy:** private IP ranges, encoded IPs, and redirect chains, tested against a real local HTTP server.
- **Fetching:** compression bombs, charsets, timeouts and size limits.
- **Extraction and crawl ranking.**
- **Upload validation:** real DOCX/PDF files, plus spoofed and corrupted files.
- **LLM client:** mocked OpenRouter, covering retries and error mapping.
- **Document assembly, DOCX output and API routes:** including rate limiting and safe error responses.

To test the full flow manually without an API key, run `npm run build && npm start`, open http://localhost:8787, and generate a document for any public business website.

## Deployment

> Nothing is deployed automatically. Review these steps and choose a target first.

The app runs as **one Node process** that serves both the API and the built client.

**Any Node host or VPS:**
```bash
npm ci
npm run build
# set env vars (at least OPENROUTER_API_KEY) in the host's secret manager or a .env file
npm start            # listens on $PORT
```
Put it behind HTTPS (e.g. Caddy or nginx) and set `TRUST_PROXY=1`.

**Docker:**
```bash
docker build -t voice-agent-reqs .
docker run -p 8787:8787 -e OPENROUTER_API_KEY=... -e TRUST_PROXY=1 voice-agent-reqs
```

**Render / Railway / Fly.io:**
- Build command: `npm ci && npm run build`. Start command: `npm start`.
- Add `OPENROUTER_API_KEY` as a secret, and set `TRUST_PROXY=1`. These platforms provide `PORT`.

**Netlify (static client + API as a Netlify Function on the same site):**

Already configured in [netlify.toml](netlify.toml) and [netlify/functions/api.mts](netlify/functions/api.mts).
- The adapter starts the existing Express app inside the function and forwards `/api/*` to it, so every route, upload check, SSRF guard and error handler is reused unchanged.
- The client keeps calling relative `/api/...` URLs.

Netlify settings:
- Leave **Base directory** empty. `netlify.toml` sets the build command (`npm run build`), the publish directory (`client/dist`) and the functions directory.
- **Environment variables** (Site configuration → Environment variables, with scope including *Functions*):
  - `OPENROUTER_API_KEY` (required)
  - `OPENROUTER_MODEL`

Netlify limits that apply ([docs](https://docs.netlify.com/build/functions/configuration/)):
- **60 s run time per request, not configurable.** The adapter defaults to `FETCH_TIMEOUT_MS=6000`, `MAX_PAGES=5` and `LLM_TIMEOUT_MS=38000`, so a slow generation ends with a clear "AI service took too long" error instead of a platform timeout.
  - Generation only succeeds if the model answers within about 38 s. The free MiniMax model took about 130 s in testing, so **use a faster model on Netlify**, or host the API elsewhere (Render or Docker; see above).
- **6 MB request body,** with uploads Base64-encoded. The adapter defaults to `MAX_UPLOAD_MB=4`, and the UI reads this limit from `/api/health`.
- **Rate limiting is per function instance,** in memory, so it is weaker than on a single server.
- Any of these defaults can be overridden with site environment variables.

**Production checklist:**
- HTTPS only.
- Store the key in the platform's secret store, never in git.
- Set a spending limit on the OpenRouter key.
- Adjust `RATE_LIMIT_PER_MIN`.
- Consider adding authentication, because the app is open to anyone who can reach it.
- If the host has an internal network, also block outbound access to it at the network/firewall level, as defence in depth.

## Known limitations

- **JavaScript-rendered sites** (SPAs) expose little HTML text and produce an "insufficient content" error. No headless browser is used.
- **Crawl scope:** the crawl only goes one link deep from the homepage. `www.` is treated as the same site; other subdomains are not. `robots.txt` is not consulted.
- **Parse timeout:** the upload parse timeout doesn't stop the parsing work already running. Very large DOCX files are limited only by the upload size cap. True isolation would need a worker thread with resource limits.
- **Rate limiting** is in-memory, per process. Use a shared store (e.g. Redis) if you run multiple instances.
- **No accounts or authentication:** documents are not stored on the server and exist only in the browser session.
- **Output quality** depends on the chosen OpenRouter model. The model must follow JSON instructions well (Claude Sonnet-class models are recommended).
