# Western Zone Dashboard Public Site

This folder is ready for free static hosting.

Deploy `index.html` with any static host:

- GitHub Pages: create a public repository, upload this folder's contents, then enable Pages for the repository.
- Netlify Drop: drag this folder into Netlify Drop to publish a public URL.
- Cloudflare Pages: connect a repository containing this folder's contents.

The page is a standalone HTML file. To keep the hosted version current after the local 7 AM refresh, copy:

`outputs/western-zone-dashboard/index-interactive-rankfix13.html`

to:

`outputs/western-zone-dashboard-public/index.html`

then redeploy or push the updated file to the hosting provider.
