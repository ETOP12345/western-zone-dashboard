# Western Zone Dashboard

Public dashboard for the Pacific Northwest 11-12 boys Western Zone ranking view.

Hosted at: https://jialiu103.github.io/western-zone-dashboard/

This GitHub repository is the source of truth for the hosted site.

The public page is generated from USA Swimming Individual Times Search data:

1. `scripts/refresh-from-usa-individual-times.mjs` refreshes `data/swimmers.json`.
2. `scripts/build-public-lite.mjs` rebuilds `index.html`.
3. `.github/workflows/daily-refresh.yml` runs the refresh daily and commits changes back to GitHub.

The dashboard defaults to 11-12 Male and shows the top 50 swimmers. The selectors at the top support age group, gender, and swimmer filtering when those groups are present in the loaded data.
