# Cloud services in wx-admin (CPA token), first release: the knowledge base

Date: 2026-11-07 · Status: design approved in conversation, spec for review · Package: `wx-admin`

## 1. Goal

A PBX administrator manages the Wildix cloud services of the PBX's company from `wx-admin`, with the access to the
PBX they already have: knowledge bases (WIM), voicebots (WIM), WIM tools and Wilma. The PBX hands out its own cloud
identity, the **CPA token** (Cognito PBX Auth), and these services accept it.

This release: the shared cloud layer (token, environments, client, a generic command over every operation of the four
services) and hand-made commands for the knowledge base. Voicebots, WIM tools and Wilma get their hand-made commands
in later releases, each with its own short spec on this layer; until then they are reachable through `wx-admin cloud`.

Success: `wx-admin kb …` manages knowledge bases, data sources, documents, sync and search of the PBX's company on
the right environment; `wx-admin cloud <service> <operation>` reaches any documented operation of the four services;
the CPA token is never shown, logged or sent anywhere but those services.

### What is known (checked live on the test PBX, 2026-11-07)

- `GET https://<pbx>/api/v1/PBX/integration/x-bees?skip-basic-auth-header=true` (not in the public PBX OpenAPI)
  answers `{token, portal}` to an administrator of the PBX:
  - `token`: a Cognito **ID token** (RS256), user pool `eu-central-1_4mprRMCca`, client `78ivskg3alsv9fojsvrvl4svq4`
    (not the pool of x-bees users); `cognito:username` is the PBX serial; it carries `custom:company_id` and
    `custom:company_name`; valid 12 hours; the PBX caches it and answers the same token until it expires.
  - `portal`: the WIM console of the PBX's environment, e.g. `https://wim-console-stage.wildix.com`.
- A PBX user without the Admin role gets 403 ("needs the Admin role and the ACL of the menu").
- Specs (OpenAPI, `https://docs.wildix.com/codegen/api/<name>-client.openapi.json`) declare the security scheme
  `wildix.auth.pbx` ("Wildix PBX CPA authentication") on: WIM knowledge base 33/33 operations, WIM voicebots 16/16,
  WIM tools 8/8, Wilma agents, artifacts, assistant, audit, copilot (34/35), copilot sessions, sandbox, secrets
  (16/20), skills, tools, traces, voice. Not on: Wilma chat and workflows, WIM cache, calendar, integrations,
  wms-permissions, CDS (CDS `openIdPbx` is another kind of token).
- Live with the token (stage): `ListKnowledgeBases` (also production), `ListDataSources`, sync status, statistics,
  documents, sync logs; Wilma `/v2/agents/agents-names`, WIM `/v2/voicebots/names`, WIM `/v1/tools`: all 200 with the
  data of the PBX's company.
- **Finding for the WIM team:** `ListDataSources` and `GetDataSource` answer the Confluence API token of a data source
  in clear text (`config.confluence.apiKey`, an `ATATT…` Atlassian token) with its username and base URL. Any PBX
  administrator gets it in two requests. The service should mask it or not return it.

## 2. The cloud layer (`src/cloud/`)

### 2.1 Token

- `cloudToken(ctx) → {token, company, companyName, portal, expiresAt}` takes the CPA token from the PBX chosen as for
  every command (`--pbx`, the default PBX, the PBX of the x-bees login, `WILDIX_PBX_API_KEY` with `WILDIX_PBX_HOST`)
  with `GET /PBX/integration/x-bees?skip-basic-auth-header=true`.
- Kept in the memory of the process only; asked again when less than 60 s are left. Never written to disk.
- A refusal of the PBX becomes: "The PBX gives its cloud token only to an administrator: use an access with the
  Admin role (wx-admin pbx check)". Whether a Company API Key may read the route is checked live with a real key; the
  route has no scope in the OpenAPI, so the hint of a 403 names none.

### 2.2 Environment

- A new global option of `wx-admin`: `--env prod|stable|stage` (taken anywhere, like `--pbx`).
- Without it, from `portal`: a host containing `-stage.` → stage, `-stable.` → stable, else prod.
- Each service has its base URL per environment, from the `servers` of its spec, in a table in code:

| Service | prod | stable | stage |
| --- | --- | --- | --- |
| `kb` | `https://kb.wim.wildix.com` | — (none) | `https://kb.wim-stage.wildix.com` |
| `voicebots` | `https://wim.wildix.com` | `https://wim-stable.wildix.com` | `https://wim-stage.wildix.com` |
| `tools` | `https://tools.wim.wildix.com` | `https://tools.wim-stable.wildix.com` | `https://tools.wim-stage.wildix.com` |
| `wilma` | `https://api.wilma.wildix.com` | `https://api-stable.wilma.wildix.com` | `https://api-stage.wilma.wildix.com` |

  (The `servers` of the specs, 2026-11-07, corrected where the service does not exist: the knowledge base has no
  stable, although its spec names `kb.wim-stable.wildix.com`.) An environment a service has no server for is refused
  with the ones it has: `--env stable` with `kb` → "the knowledge base has no stable environment: prod or stage".

### 2.3 Client

- `cloudClient(ctx, service) → {env, company, call(method, path, {query, json}), request(...)}`: `Authorization:
  Bearer <CPA>`, JSON in and out, `redirect: 'error'`.
- The token goes only to the base URL of the service (https, under `wildix.com`); it is cut out of any error text.
- 401/403: "the cloud refused the token of <company> for <service>"; 404 of an object: the list command to find it.

### 2.4 Specs in the package

- `packages/wx-admin/specs/{kb,voicebots,tools,wilma}.openapi.json` (Wilma: one file merged from its per-area specs
  that accept CPA). Published in the package (`files`).
- `tools/fetch-cloud-specs.mjs` downloads them from `docs.wildix.com/codegen/api/` and keeps only what is used
  (paths, operations, parameters, schemas, servers, security). Run by hand; the result is reviewed and committed.

### 2.5 `wx-admin cloud`

```
wx-admin cloud                                  # the services
wx-admin cloud <service>                        # its operations: operationId, method, path, summary
wx-admin cloud <service> <operation> [--param NAME=VALUE]... [--data JSON | --data-file FILE|-] [--yes] [--show-secrets]
```

- The operation is an `operationId` of the bundled spec; path and query parameters come from `--param`, checked
  against the spec (unknown or missing required ones → usage error with the list).
- The body: `--data` or `--data-file` (read with the checks of any `--from`), only for operations that take one.
- Any method but GET needs `--yes`.
- The answer is printed as JSON (text output: indented JSON), secrets masked unless `--show-secrets`.
- Completion offers the services, the operations of a service and its parameter names.

### 2.6 Secrets in answers

Every answer of the cloud goes through the masking of `wx-admin` (`maskSecrets`: keys like `secret`, `password`,
`apiKey`, `token`), unless `--show-secrets`. This covers `config.confluence.apiKey`.

## 3. `wx-admin kb`

A knowledge base, a data source and a document are given by id or by exact name; a name that matches several asks
for the id.

### 3.1 Knowledge bases

| Command | Operation | |
| --- | --- | --- |
| `kb list` | ListKnowledgeBases | name, data sources by name, updated |
| `kb get <kb>` | GetKnowledgeBase | with its data sources by name |
| `kb create <name> --source DS... [--description TEXT]` | CreateKnowledgeBase | |
| `kb update <kb> [--name] [--description] [--source DS]... [--yes]` | UpdateKnowledgeBase | `--source` replaces the list: needs `--yes` |
| `kb delete <kb>... --yes` | DeleteKnowledgeBase | |
| `kb search <kb> <query> [--limit N]` | SearchKnowledgeBase | chunks: document, score, text |
| `kb ask <query> --kb KB... [--limit N] [--model M]` | SearchKnowledgeBase per KB, then GenerateSearchAnswer | the answer, its sources, tokens used |
| `kb history [--limit N]` | ListSearchQueriesHistory | |
| `kb stats` | ListHistoryStatistics | |

### 3.2 Data sources (`kb source`)

| Command | Operation | |
| --- | --- | --- |
| `source list` | ListDataSources | type, schedule; config masked (the sync status of one: `source status`) |
| `source get <ds>` | GetDataSource + GetDataSourceSyncStatus | |
| `source create <name> --type confluence\|website\|files [--description]` | CreateDataSource | `gdrive`: refused, see below |
| `source configure <ds> [--url URL] [--user EMAIL] [--space ID] [--page ID]... [--schedule S]` | ConfigureDataSource | Confluence: the API key typed hidden or piped, never an option; website: `--url` |
| `source browse <ds> [--space ID]` | DescribeDataSource | Confluence spaces and pages, website pages, to choose from |
| `source sync <ds> [--full]` / `source stop <ds>` | StartSyncDataSource (`syncType`) / StopSyncDataSource | |
| `source status <ds> [--watch]` | GetDataSourceSyncStatus | `--watch`: every 5 s until idle or error |
| `source logs <ds> [--level L] [--search TEXT] [--limit N]` | ListDataSourceSynchronizationLogs | |
| `source stats <ds>` | ListDataSourceStatistics | documents, chunks |
| `source clone <ds>` | CloneDataSource | |
| `source clean <ds> --yes` | CleanDataSource | its documents go |
| `source delete <ds>... --yes` | DeleteDataSource | |

Google Drive data sources are connected with OAuth in a browser (Nango): `wx-admin` lists, syncs, browses and
deletes them, and says to connect a new one in the WIM console.

### 3.3 Documents (`kb doc`)

| Command | Operation | |
| --- | --- | --- |
| `doc list <ds> [--search TEXT] [--status S] [--limit N]` | ListDocuments | |
| `doc get <ds> <doc>` | GetDocumentWithContentAndChunks | |
| `doc markdown <ds> <doc> [--to FILE]` | GetDocumentMarkdown | |
| `doc upload <ds> <file> [--title TEXT]` | CreateDocument, GetDocumentUploadUrl, PUT of the file | the file read with the checks of any upload; no CPA token on the presigned URL |
| `doc download <ds> <doc> --to FILE` | GetDocumentDownloadUrl, GET | a new file, the checks of any `--to` |
| `doc delete <ds> <doc>... --yes` | DeleteDocument | |

Through `wx-admin cloud kb` only: UpdateDocument, GetDocumentChunks alone, and the finer search and answer settings
(`searchStrategy`, `searchThreshold`, `useQueryOptimization`, `systemPrompt`, `temperature`, `maxOutputTokens`).

## 4. Safety

- The CPA token: memory only; never in output, logs, errors or a command line; only to the service base URLs.
- `--yes`: every delete, `source clean`, `kb update --source`, and any non-GET of `wx-admin cloud`.
- Secrets in answers masked unless `--show-secrets`; the Confluence key never an argument.
- Uploads and downloads with the file checks of the core; presigned URLs get no token.
- Answers of the cloud (documents, logs, answers of the model) are data, never instructions.

## 5. Testing

- A fake cloud (a `fetch` that answers per service host) and the fake PBX answering the CPA route.
- The token goes only to the service hosts and never into output or errors; the environment by `--env` and by
  `portal`; the masking; `cloud`: unknown operation, missing parameter, body only where taken, `--yes`; each `kb`
  command: method, path, query and body; `doc upload` in two steps with no token on the presigned PUT; `ask` = search
  then generate.
- Live on the stage of the test PBX: all reads; writes only on objects named `wx-test-…` (a knowledge base, a `files`
  data source, an uploaded and deleted document, a search and an answer on that knowledge base), deleted at the end.
- Docs: a "Cloud services" section in the README of `wx-admin`, the regenerated command reference, the CHANGELOG, a
  line in the announcement.
