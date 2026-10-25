# Contributing to Newsbee

## How work flows

`main` is the only long-lived branch and is always deployable. Nobody pushes to it directly.

1. Pull the latest `main`, then branch from it with a short name:
   - `feat/<what>` for new features, e.g. `feat/events-calendar`
   - `fix/<what>` for bug fixes, e.g. `fix/legistar-dates`
   - `chore/<what>` for tooling, docs and dependencies
2. Keep the branch small and short-lived: open a pull request within a few days.
3. Open a PR against `main`. CI runs only the checks for the parts you changed, and Vercel posts a preview link.
4. Get one approval and a green `ci-ok` check, then **squash and merge**. The branch is deleted automatically.

The frontend and backend are kept apart by folder, not by branch, so a feature that touches both lands in one PR.

## Commit and PR titles

Use the same prefixes as branches: `feat: add View Ridge community`, `fix: handle empty Legistar agendas`. Squash merging makes the PR title the commit on `main`.

## Local setup

Use Node 24 (see `.nvmrc`). Install **both** apps, because the journalist-site tests import reader-site code:

```bash
cd apps/reader-site && npm ci
cd ../journalist-site && npm ci
```

Before opening a PR, run the checks for what you changed:

| Changed | Run in that folder |
|---|---|
| `apps/journalist-site` | `npm run lint && npm test` |
| `apps/reader-site` | `npm run check && npm run build` |

`npm run local` in `apps/journalist-site` starts the full local stack; see the README for details.

## Secrets

Never commit API keys or `.env` files; `.gitignore` already blocks them. Environment variables are listed in the READMEs. Put real values in your local `.env` and in the Vercel project settings.
