# Western Zone Dashboard

Public dashboard for the Pacific Northwest 11-12 boys Western Zone ranking view.

Hosted at: https://jialiu103.github.io/western-zone-dashboard/

This GitHub repository is the source of truth for the hosted site.

The public page is generated from official USA Swimming Data Hub data:

1. `scripts/refresh-from-usa-event-rank.mjs` refreshes `data/swimmers.json` from Top Times / Event Rank Search for all configured age groups and genders.
2. `scripts/build-public-lite.mjs` rebuilds `index.html`.
3. `scripts/validate-age-groups.mjs` must pass before publishing. It checks that every published swimmer is in the correct current-age group, and it fails if loaded age-at-meet data would move a swimmer into a different age group than their stored age.
4. `.github/workflows/daily-refresh.yml` runs the refresh daily, validates the age groups, and commits changes back to GitHub.

The dashboard defaults to 11-12 Male and shows the top 50 swimmers. The selectors at the top support age group, gender, and swimmer filtering when those groups are present in the loaded data.

Before any manual publish, always run:

```sh
node scripts/build-public-lite.mjs
node scripts/validate-age-groups.mjs
```
