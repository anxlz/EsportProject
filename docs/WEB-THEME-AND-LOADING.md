# Web theme and global loading

The app supports **system**, **light**, and **dark** themes. The root layout reads the saved
preference before first paint; the header toggle cycles system → light → dark → system. The
palette lives in `apps/web/src/app/globals.css`, including semantic surface, text, border,
primary, status, and chart tokens. Contract print/PDF surfaces retain a white page.

The root loading layer shows briefly during initial hydration, on internal route changes and
form submission, and for button/select actions that issue an API request. It ignores modified,
external, download, new-tab, and same-page hash navigation. Requests stop the indicator when
they finish; route changes stop it when the new route renders. A 15-second safety limit prevents
it from remaining visible indefinitely.

Manual checks:

1. Change the OS preference, then cycle the header theme toggle; reload after each explicit
   choice and confirm it persists without a flash.
2. Check dashboard, dialogs, tables, badges, charts, auth pages and contract editor in both
   themes; print or export a contract and confirm its page remains white.
3. Navigate with a normal internal link, a hash link, Ctrl/Cmd-click, an external link and a
   download link. Only normal internal navigation should show the loading layer.
4. Submit a form and trigger a dashboard action that makes an API request. Confirm the layer
   clears on response and never remains past its safety timeout.
