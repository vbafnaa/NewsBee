# Deployment policy

- Never queue, request, or manually trigger Vercel preview deployments for pull requests or non-`main` branches.
- Deploy to Vercel only from `main` after merge. Validate branch changes with local builds and tests instead of previews.
- Keep both app projects' `git.deploymentEnabled` rules restricted to `main`.

# Git workflow

- Always pull the latest remote changes before pushing. Treat `main` as the source of truth, resolve conflicts, and validate the result before pushing.

# Project context

For Newsbee context, start with [the knowledge index](knowledge/index.md). Open only the relevant topic, then verify details against the linked code or docs. Update that topic when a change makes it stale.
