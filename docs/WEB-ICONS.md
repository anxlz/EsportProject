# Web app icons

The app's Club Manager crest is maintained as `apps/web/src/app/icon.svg`. Next.js exposes
that scalable icon, `/favicon.ico`, `/apple-icon.png`, and `/manifest.webmanifest` using the
App Router metadata conventions. The multi-size favicon contains 16, 32, and 48 pixel renditions;
the iOS icon is 180 pixels. Android icons are the 192 and 512 pixel PNGs in `apps/web/public`.

The manifest's browser chrome uses the app's turf green, and its standalone install surface uses
the light page background. The crest itself uses a fixed dark-green field with a white shield and
amber accent, so it remains legible in either system color scheme without an alternate artwork.

Vercel's catch-all rewrite routes to the **web** service. The Next.js API rewrite only matches
`/api/:path*`, so the favicon, icon, Apple touch icon, and manifest routes remain on the web app.
