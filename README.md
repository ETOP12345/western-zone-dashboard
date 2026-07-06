# Western Zone Dashboard

Public dashboard for Team Pacific Northwest Western Zone ranking views across supported age groups and genders.

Hosted at: https://jialiu103.github.io/western-zone-dashboard/

This GitHub repository is the source of truth for the hosted site.

The public page is generated from official USA Swimming data:

1. `scripts/refresh-from-usa-event-rank.mjs` refreshes `data/swimmers.json` from the current Top Times API used by data.usaswimming.org for all configured age groups and genders.
2. `scripts/build-public-lite.mjs` rebuilds `index.html`.
3. `scripts/validate-age-groups.mjs` must pass before publishing. It checks every published swimmer against the current `data/swimmers.json` source record and fails if the published age, age group, or gender no longer matches the source data.
4. `.github/workflows/daily-refresh.yml` runs the refresh daily, validates the age groups, and commits changes back to GitHub.
5. `.github/workflows/validate-dashboard.yml` also runs the same validation on every push and pull request so manual publishes get checked too.

The old USA Swimming Sisense/DataHub Event Rank route now redirects to the new Top Times app. If the daily refresh stops updating again, first verify that `scripts/refresh-from-usa-event-rank.mjs` still receives non-empty rows from `https://times-api.usaswimming.org/swims/TimesSearch/GetTopTimesLeaderBoard`.

The dashboard defaults to 11-12 Male and shows the top 50 swimmers. The selectors at the top support age group, gender, and swimmer filtering when those groups are present in the loaded data. A prominent disclaimer makes clear that the scoring is unofficial and may contain mistakes or wrong interpretations. The right-side details are generic and update based on the selected view or clicked row; no swimmer is hardcoded as a featured athlete.

Before any manual publish, always run:

```sh
node scripts/build-public-lite.mjs
node scripts/validate-age-groups.mjs
```

Do not publish `index.html` if validation fails. A stale page can look internally consistent, for example by showing a swimmer as age 12 in `11-12`, while the refreshed source record says that swimmer now belongs in `13-14`.
