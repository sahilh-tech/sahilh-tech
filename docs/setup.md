# Contribution graph setup

The daily workflow queries every identity in `accounts.json` and publishes only combined daily totals, per-account totals, and date metadata. It runs daily at 16:17 UTC and can also be started with **Actions → Update combined contributions → Run workflow**.

Create one OAuth or classic personal access token per account with the `read:user` scope needed for private contribution totals. Add each token as a repository Actions secret under **Settings → Secrets and variables → Actions**. If a credential is revoked or changed, rotate the corresponding secret:

| Secret | Account |
| --- | --- |
| `CONTRIB_TOKEN_LAB` | `Sahil24-lab` |
| `CONTRIB_TOKEN_TECH` | `sahilh-tech` |
| `CONTRIB_TOKEN_AROBOTIX` | `sahil-arobotix` |
| `CONTRIB_TOKEN_ACTIFIED` | `sahil-actified` |
| `CONTRIB_TOKEN_MODAIS` | `sahil-modais` |

The workflow needs only repository `contents: write` permission to commit generated assets. Each token's viewer identity is checked against the configured login, and any missing data or GraphQL failure stops the run before assets are changed. Tokens and API response bodies are never written to logs. The published files do not include repository names, organization names, events, or restricted contribution counts.
