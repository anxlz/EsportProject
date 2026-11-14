# Contract text styles

Contract drafts can set a document font family, shipped weight, and six-digit hex text color from
the Details tab. Cairo / 400 / `#1c2321` is the default. Colors are checked against the white
document page using WCAG contrast ratio; a ratio below 4.5:1 warns but does not prevent saving.

The API validates family/weight pairs and `#RRGGBB` colors. The current style is stored on the
contract row and in each immutable contract version, so previews and PDF exports use the version's
style. Existing versions without a style render with the default. PDF font files are installed
locally and embedded in the generated document; no runtime font CDN is used.
The schema change is in `apps/api/drizzle/0017_certain_outlaw_kid.sql`.

Available weights are:

| Family                         | Weights                      |
| ------------------------------ | ---------------------------- |
| Cairo                          | 300, 400, 500, 600, 700, 800 |
| Tajawal                        | 300, 400, 500, 700, 800      |
| IBM Plex Sans Arabic           | 300, 400, 500, 600, 700      |
| Noto Kufi Arabic               | 300, 400, 500, 600, 700, 800 |
| Almarai                        | 300, 400, 700, 800           |
| IBM Plex Sans (Latin fallback) | 300, 400, 500, 600, 700      |

To try it:

1. Apply pending database migrations with `bun run db:migrate`.
2. Open a draft contract, choose a family, an available weight, and a preset or custom color.
3. Check the live preview and low-contrast warning, save, reload, and confirm the style persists.
4. Open the Preview tab and download the PDF. Check that the selected face and weight render in
   both Arabic and English. Try the Latin fallback as well.
