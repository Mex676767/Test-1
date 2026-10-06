# Production deployment

After committing and pushing the approved changes, run `./scripts/deploy.ps1` from PowerShell. It deploys a clean archive of HEAD, excluding uncommitted work, and stamps the same Git commit into the page's `widget-release` meta tag and `/release.json`.

Use this deployment script for future releases. The widget compares explicit release IDs every minute. It refreshes once for a changed release only when Blast (including cleanup), lookups, and editing are idle. It does not use ETags or content lengths. Development previews do not poll. The release marker is generated in the release archive, not in the working tree.

A LiveChat-driven iframe replacement is separate from this update mechanism. Blast saves delivery checkpoints and visible drafts in account-scoped session storage so they survive those replacements. Do not mark a delivery complete until cleanup has finished, and never blindly resend an event with an unconfirmed response.
