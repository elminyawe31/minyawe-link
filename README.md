# MINYAWE-LINK

File vault with a direct-link focus: upload images, audio, video or any file and get **3 branded links** (preview page + direct stream + download) — no account required.

## Features
- **Multi upload** — up to 10 files at once, each with its own progress bar and links
- **Per-file password** — optional `password` field on upload, or set/change/remove later from the admin panel (stored hashed, never plain text; access via `?pw=`)
- **Auto expiry** — retention `1h / 24h / 7d / 30d`; expired files are removed from the index and local disk automatically (sweeper every 5 minutes + instant check on access with `410`)
- **Admin panel** — file search, lock/delete, one-click ZIP backup, operation log with IP + timestamp
- **Backup** — one click downloads a ZIP containing the links database, the audit log, all stored files and the server source
- **Audit log** — every upload / delete / expiry / password change / backup is recorded
- **Light / dark theme** with persistence + fully responsive layout (mobile / tablet / laptop / desktop)
- Drag & drop, `Ctrl+V` paste, QR codes, albums, view counters, custom URL slugs
- Machine-ready API: JSON docs at `/api/docs` + `llms.txt` for AI agents

## Quick start

### Railway (recommended)
1. Push this repo to GitHub
2. Railway → New Project → Deploy from GitHub repo
3. Add a Volume with Mount Path: `/data`
4. Add Variables:
```
ADMIN_TOKEN=<choose-a-strong-secret>
MAX_FILE_SIZE_MB=200
BASE_URL=https://<your-domain>.up.railway.app
DATA_DIR=/data
```
5. Networking → Generate Domain → set it as `BASE_URL` and Redeploy
6. Verify: `/health` returns `MINYAWE-LINK OK`

### Local / Docker
```
npm install
PORT=3000 DATA_DIR=./data ADMIN_TOKEN=secret npm start
```

## Environment variables
| Variable | Meaning | Default |
|---|---|---|
| `ADMIN_TOKEN` | Enables the admin panel and admin API (required for management) | — (admin disabled) |
| `BASE_URL` | Public base URL used to build share links | auto-detected |
| `DATA_DIR` | Data directory (database + uploads + audit log) | `/data` |
| `MAX_FILE_SIZE_MB` | Max file size | `200` |
| `STORAGE_DRIVER` | Set to `local` to force local-disk storage only | external + local fallback |
| `RATE_MAX` | Max requests per IP per 10 minutes (multi-upload uses one request per file) | `60` |

## API
| Method | Path | Description |
|---|---|---|
| POST | `/api/upload` | Upload (`file` + `expiry` + optional `alias` + optional `password`) — returns `locked` |
| POST | `/api/album` | Album of up to 10 files (`files`) on one `/a/:id` page |
| GET | `/api/stats?limit=` | Counters + top files (admin sees details and up to 100 rows) |
| GET | `/api/check?ids=` | Existence check for a comma-separated id list (no side effects) |
| GET | `/v/:id` | Preview page (unlock form shown automatically for protected files — `?pw=`) |
| GET | `/e/:id` | Direct stream (inline + Range) — protected files need `?pw=` |
| GET | `/d/:id` | Direct download (attachment) — protected files need `?pw=` |
| GET | `/i/:id` | Short link — protected files need `?pw=` |
| DELETE | `/api/:id?token=` | Delete (per-file token or admin) |
| GET | `/api/config` | Limits + status |
| GET | `/api/docs` | Machine-readable JSON spec |
| GET | `/llms.txt` | AI agent guide |
| GET | `/health` | Liveness probe |

## Admin API (header `x-admin-token` or `?admin=TOKEN`)
| Method | Path | Description |
|---|---|---|
| POST | `/api/:id/password` | Set/change password `{password}` — empty string `""` removes it |
| GET | `/api/admin/files?q=` | Full file list + search (name / slug / id) |
| GET | `/api/admin/audit?q=&limit=` | Operation log with IP and timestamp |
| GET | `/api/admin/backup` | ZIP download: links database + audit log + stored files + server source |

## Notes
- Retention is capped at 30 days (`30d` behaves as the maximum).
- Blocked extensions: executables and scripts (`.exe` `.bat` `.ps1` `.jar` `.msi` …).
- The "My files" tab is stored per browser; entries are verified against the server on open and anything deleted or expired is removed from the list automatically.
