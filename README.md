# Western Zone Dashboard

Public dashboard for the Pacific Northwest 11-12 boys Western Zone ranking view.

Hosted at: https://jialiu103.github.io/western-zone-dashboard/

This GitHub repository is the source of truth for the hosted site.

The public page is generated from official USA Swimming data:

1. `scripts/refresh-from-usa-event-rank.mjs` refreshes `data/swimmers.json` from the current Top Times API used by data.usaswimming.org for all configured age groups and genders.
2. `scripts/build-public-lite.mjs` rebuilds `index.html`.
3. `scripts/validate-age-groups.mjs` must pass before publishing. It checks every published swimmer against the current `data/swimmers.json` source record and fails if the published age, age group, or gender no longer matches the source data.
4. `.github/workflows/daily-refresh.yml` runs the refresh daily, validates the age groups, commits changes back to GitHub, and emails when Ethan Wang's rank, score, or roster status changes.
5. `.github/workflows/validate-dashboard.yml` also runs the same validation on every push and pull request so manual publishes get checked too.

The old USA Swimming Sisense/DataHub Event Rank route now redirects to the new Top Times app. If the daily refresh stops updating again, first verify that `scripts/refresh-from-usa-event-rank.mjs` still receives non-empty rows from `https://times-api.usaswimming.org/swims/TimesSearch/GetTopTimesLeaderBoard`.

The dashboard defaults to 11-12 Male and shows the top 50 swimmers. The selectors at the top support age group, gender, and swimmer filtering when those groups are present in the loaded data.

Before any manual publish, always run:

```sh
node scripts/build-public-lite.mjs
node scripts/validate-age-groups.mjs
```

Do not publish `index.html` if validation fails. A stale page can look internally consistent, for example by showing a swimmer as age 12 in `11-12`, while the refreshed source record says that swimmer now belongs in `13-14`.

## Ethan rank-change email

The email step is wired into the daily GitHub Action, but GitHub needs SMTP secrets before it can send mail. Add these repository secrets in GitHub under Settings -> Secrets and variables -> Actions:

- `SMTP_HOST`: for Gmail, use `smtp.gmail.com`
- `SMTP_PORT`: for Gmail SSL, use `465`
- `SMTP_SECURE`: use `true`
- `SMTP_USER`: the sending email address
- `SMTP_PASS`: the SMTP password or Gmail app password
- `EMAIL_FROM`: the sending email address

`EMAIL_TO` is set in the workflow as `liujiauestc@gmail.com`. The workflow only sends an email when Ethan Wang's rank, score, or status changes compared with the previous published dashboard snapshot.
