# Workday API Client

Node.js CLI that pulls employee document data from Workday (RaaS reports, Staffing SOAP, Blobitory, Recruiting) and writes files locally under `mock/`, with optional upload to Infor SFTP.

**Requirements:** Node.js **18+** and npm.

---

## How the app works

```mermaid
flowchart TB
  CLI["CLI<br/>node src/index.js"]
  CFG["Load config JSON<br/>--config or WORKDAY_CONFIG"]
  API["Select handler<br/>--api &lt;name&gt;"]

  CLI --> CFG --> API

  API --> MODE{Mode}

  MODE -->|--mock true| MOCK["Sample / local path<br/>no live Workday or SFTP<br/>when supported"]
  MODE -->|--mock false| LIVE["Live run"]

  LIVE --> SRC{Data source by API}

  SRC --> RAAS["Workday RaaS<br/>list ± detail reports<br/>Basic Auth"]
  SRC --> STAFF["Staffing SOAP<br/>Get_Workers + documents<br/>SOAP credentials"]
  SRC --> BLOB["Blobitory<br/>PDF by Document ID"]
  SRC --> REC["Recruiting SOAP<br/>when required"]

  RAAS --> PARSE["Parse XML · filter · name files"]
  STAFF --> PARSE
  BLOB --> PARSE
  REC --> PARSE

  PARSE --> LOCAL["Save under mock/"]
  LOCAL --> SFTP["Upload to SFTP<br/>remote root from config"]
  LOCAL --> RPT["Write summary under reports/"]
  SFTP --> RPT
```

**Typical live flow (per API):**

1. Load tenant credentials and endpoints from a configuration file.  
2. Load a worker list (RaaS list report or equivalent).  
3. For each worker (batched, with concurrency), fetch document content.  
4. Save files under `mock/` using the API’s path convention.  
5. Upload to SFTP under the configured remote root.  
6. Write a JSON/Markdown run summary under `reports/`.

Not every API uses every source (some are RaaS-only, some Staffing-only, some Blobitory). Use `--list-apis` for the full set of handlers.

---

## Install Node.js and npm

### Windows

**Option A — Official installer**

1. Open [https://nodejs.org/](https://nodejs.org/) and download the **LTS** installer.  
2. Run the installer (include npm; leave “Add to PATH” enabled).  
3. Open a **new** PowerShell or Command Prompt window:

```powershell
node -v
npm -v
```

**Option B — winget**

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen the terminal, then check `node -v` and `npm -v`.

### macOS

**Option A — Official installer**

1. Download the **LTS** package from [https://nodejs.org/](https://nodejs.org/).  
2. Install, then open Terminal:

```bash
node -v
npm -v
```

**Option B — Homebrew**

```bash
brew install node
node -v
npm -v
```

---

## Project setup

From the project root:

```bash
npm install
```

Dependencies: `dotenv`, `fast-xml-parser`, `ssh2-sftp-client`.

---

## Configuration (required)

Every live run needs a config file via **`--config <path>`** or the **`WORKDAY_CONFIG`** environment variable. There is **no default** path.

### Config file shape

```json
{
  "soapCredentials": {
    "User": "integration_user@tenant_name",
    "Password": "********"
  },
  "basicCredentials": {
    "User": "integration_user",
    "Password": "********"
  },
  "sftpCredentials": {
    "Host": "sftp.example.com",
    "Port": 22,
    "User": "sftp_user",
    "Password": "********",
    "RemoteRoot": "/ROI/Workday"
  },
  "Tenant_domain": "wdX-impl-services1.workday.com",
  "Tenant_server": "your_tenant"
}
```

| Field | Used for |
|-------|----------|
| `basicCredentials` | Workday RaaS (Basic Auth) |
| `soapCredentials` | Staffing / Blobitory SOAP-style auth (`user@tenant`) |
| `sftpCredentials` | Infor (or other) SFTP uploads |
| `Tenant_domain` | Host for Workday service URLs |
| `Tenant_server` | Tenant name in Workday URLs |

Optional per-field overrides: set `WORKDAY_*` or `SFTP_*` in the environment (or a local `.env`; see `.env.example`). File values apply when overrides are unset.

Keep real passwords out of git; use env-specific config files outside version control when possible.

---

## CLI usage

```text
node src/index.js --api <name> --config <path> [options]
node src/index.js --list-apis
node src/index.js --help
```

### Required (for a real API run)

| Flag | Description |
|------|-------------|
| `--api <name>` | Handler to run (see `--list-apis`) |
| `--config <path>` | Path to configuration JSON (or set `WORKDAY_CONFIG`) |

### Common options

| Flag | Default | Description |
|------|---------|-------------|
| `--mock <true\|false>` | `false` | `true` = sample/local path when implemented; `false` = live Workday + SFTP |
| `--page-size <n>` | `5` | Workers per batch |
| `--concurrency <n>` | `5` | Parallel workers within a batch |
| `--max-pages <n>` | all | Stop after N batches |
| `--max-employees <n>` | varies | Cap workers processed (some APIs: per category) |
| `--worker-wid <wid>` | — | Single worker (where supported) |
| `--workers-file <path>` | — | Local worker list (where supported) |
| `--list-apis` | — | Print registered API names and exit |
| `-h`, `--help` | — | Help text |

### List APIs

```bash
node src/index.js --list-apis
```

Example output (names grow as handlers are registered):

```text
Available APIs:

  report-info
  job-description
  education
  personal
  certification
  ...

Total: 20
```

---

## Meaningful command examples

Replace the config path with your environment’s file.

### 1. Discover APIs (no config required)

```bash
node src/index.js --list-apis
```

### 2. Live run — first 20 workers (smoke test)

```bash
node src/index.js \
  --api education \
  --config ./path/to/preview-configuration.json \
  --mock false \
  --max-employees 20 \
  --concurrency 5
```

**Windows PowerShell** (same idea, one line):

```powershell
node src/index.js --api education --config .\path\to\preview-configuration.json --mock false --max-employees 20 --concurrency 5
```

### 3. Small batch control (debug)

```bash
node src/index.js \
  --api benefit-event \
  --config ./path/to/preview-configuration.json \
  --mock false \
  --page-size 5 \
  --max-pages 1 \
  --concurrency 2
```

### 4. Personal documents (Staffing categories)

```bash
node src/index.js \
  --api personal \
  --config ./path/to/preview-configuration.json \
  --mock false \
  --max-employees 10 \
  --concurrency 8
```

For `personal`, `--max-employees` means **employees per document category** (not always a global employee cap).

### 5. Generated document / Blobitory-style export

```bash
node src/index.js \
  --api job-description \
  --config ./path/to/preview-configuration.json \
  --mock false \
  --max-employees 20
```

### 6. Use env var instead of repeating `--config`

**macOS / Linux:**

```bash
export WORKDAY_CONFIG=./path/to/production-configuration.json
node src/index.js --api pay-increase --mock false --max-employees 50
```

**Windows PowerShell:**

```powershell
$env:WORKDAY_CONFIG = ".\path\to\production-configuration.json"
node src/index.js --api pay-increase --mock false --max-employees 50
```

### 7. Missing config (expected error)

```bash
node src/index.js --api education --mock false
```

Exits with an error that `--config` (or `WORKDAY_CONFIG`) is required.

---

## Outputs

| Location | Contents |
|----------|----------|
| `mock/` | Local copies of downloaded files (also used as staging for SFTP) |
| `reports/` | Per-run JSON and Markdown summaries (`{api}-latest.md`, timestamped runs) |
| SFTP remote root | Uploaded files under paths defined by each API’s naming rules |

`mock/` and `reports/` are gitignored by default.

---

## High-level architecture

```mermaid
flowchart LR
  subgraph inputs [Inputs]
    CFG2[Config JSON]
    CLI2[CLI flags]
  end

  subgraph app [Application]
    IDX[src/index.js]
    REG[API registry]
    LIB[Clients · parsers · naming · SFTP]
  end

  subgraph external [External systems]
    WD[Workday]
    FTP[SFTP server]
  end

  subgraph outputs [Outputs]
    MOCK2[mock/]
    REP[reports/]
  end

  CLI2 --> IDX
  CFG2 --> IDX
  IDX --> REG
  REG --> LIB
  LIB --> WD
  LIB --> FTP
  LIB --> MOCK2
  LIB --> REP
```

| Area | Role |
|------|------|
| `src/index.js` | Entry point, validates flags, loads config |
| `src/apis/` | One handler per `--api` value |
| `src/lib/` | HTTP/SOAP clients, XML parsing, parallel batching, file naming, SFTP, run reports |
| `src/config.js` | Config load, tenant URL builders, credential accessors |

---

## npm scripts

```bash
npm start -- --list-apis
npm start -- --api education --config ./path/to/config.json --mock false --max-employees 5
```

(`npm start` runs `node src/index.js`; pass CLI args after `--`.)

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| `--config is required` | Pass `--config` or set `WORKDAY_CONFIG` |
| Config file not found | Path relative to current directory or project root |
| Invalid JSON / missing fields | Schema must include soap, basic, tenant domain/server |
| Workday 401 / SOAP fault | Credentials and tenant name for that environment |
| Invalid Employee_ID | Some list IDs are not valid for Staffing; treat as skip/dead-letter candidates |
| SFTP failures | Host, port, user, password, remote root, network allowlist |

---

## License / notes

Internal integration tool. Do not commit secrets. Prefer separate config files per environment (preview, sandbox, production).
