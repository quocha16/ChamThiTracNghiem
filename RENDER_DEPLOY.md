# QuizGrader - Render deployment

## Render Web Service
- Root Directory: leave blank (package.json is in repository root)
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`

## Environment variables
Set in Render Dashboard -> Web Service -> Environment:
- `NODE_ENV` = `production`
- `DATABASE_URL` = Internal Database URL copied from the Render PostgreSQL service
- `UPLOAD_DIR` = `/var/data/uploads` (only when a Persistent Disk is attached at `/var/data`)

The app also supports the local `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
and `DB_PASSWORD` variables.

## PostgreSQL
Create a Render PostgreSQL database in the same region as the Web Service.
Use its Internal Database URL as `DATABASE_URL`.

The Render database is separate from the local Docker database. Existing local
records are not copied automatically. Export/import them separately if needed.

## Uploaded files
Without a Persistent Disk or external object storage, files written by Multer
may be lost when the service restarts or redeploys. To retain uploads, attach
a Persistent Disk mounted at `/var/data` and set `UPLOAD_DIR=/var/data/uploads`.
Check current Render plan and disk pricing.

## Deploy
Push the project to GitHub, connect the repository in Render, and deploy.

## Database migration for camera scanning (OMR)
`database/schema.sql` now has an extra `-- MIGRATION` block at the end
(new columns on `submissions`, `detected_answers`, `grading_results`).
This only runs automatically when Postgres initializes a brand-new,
empty database (first deploy, or a fresh Render PostgreSQL instance).

If you already had a database running before this update (local Docker
volume, or an existing Render PostgreSQL service), the init script will
NOT run again, so you must apply the migration manually once:

```
psql "<DATABASE_URL or local connection string>" -f database/schema.sql
```

This is safe to run multiple times — every statement in the migration
block uses `ADD COLUMN IF NOT EXISTS`.

## Camera scanning (OMR) notes
- The scan feature (`POST /api/submissions/scan`) needs the phone/browser
  camera, which requires HTTPS — Render's default `*.onrender.com` URL
  already serves HTTPS, so no extra config is needed there. For local
  Docker testing over plain HTTP, only `localhost` is treated as secure
  by browsers; test on `http://localhost:3000`, not a LAN IP, or the
  camera button will be blocked by the browser.
- Annotated (graded) images are written under `UPLOAD_DIR/annotated/`.
  They are subject to the same "Uploaded files" persistence note above —
  attach a Persistent Disk if you need them to survive a redeploy/restart.
- The bubble coordinates in `backend/omr/template.js` are tuned to the
  "PHIẾU TRẢ LỜI TRẮC NGHIỆM" 40-question (A-D) answer sheet. If you print
  on a different paper size/printer or your answer sheet layout differs,
  use `POST /api/omr/calibration-preview` (upload one blank, unfilled
  sheet) to see blue dots drawn over the detected bubble centers, and
  adjust the fractional coordinates in `template.js` until they land in
  the center of each circle.
