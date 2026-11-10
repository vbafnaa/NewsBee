# Contributing to Newsbee

## How work flows

`main` is the only long-lived branch and is always deployable. Nobody pushes to it directly.

1. Pull the latest `main`, then branch from it with a short name:
   - `feat/<what>` for new features, e.g. `feat/events-calendar`
   - `fix/<what>` for bug fixes, e.g. `fix/legistar-dates`
   - `chore/<what>` for tooling, docs and dependencies
2. Keep the branch small and short-lived: open a pull request within a few days.
3. Open a PR against `main`. CI runs only the checks for the parts you changed. Vercel deploys only `main` (`vercel.json`), so a PR has no preview deployment.
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

## Pulling in the upstream repository

This repository follows [g2minhle/Newsbee](https://github.com/g2minhle/Newsbee), but not its
history: upstream's history still holds `deploy.txt`, `Docs/operations-inventory.md` (cloud
project IDs and service-account emails) and `archive/python`, which were removed from this
repository's history. So never `git merge upstream/main` or push upstream commits here. Bring in
upstream's changes as ordinary edits instead:

```bash
git switch -c chore/sync-upstream origin/main
sh scripts/sync-upstream.sh <sha>   # the "Upstream:" line of the last sync commit
```

The script adds the `upstream` remote if needed, three-way merges everything upstream changed
since that commit, and leaves the three paths out. Resolve any conflicts, run the checks, and
commit with `Upstream: <new sha>` in the message (the script prints it), then open a PR as usual.

## Secrets

Never commit API keys or `.env` files; `.gitignore` already blocks them. Environment variables are listed in the READMEs. Put real values in your local `.env` and in the Vercel project settings.
