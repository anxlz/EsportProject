# Web motion and smooth scrolling

The root `Providers` mounts one `SmoothScrollProvider`. It loads Lenis, GSAP and ScrollTrigger only
in the browser, drives Lenis from the GSAP ticker, and removes its ticker and listeners on cleanup.
When reduced motion is requested, Lenis is not started and the GSAP reveal component skips its
animations. The preference is watched at runtime so changing it does not require a reload.

The small reusable effects in `apps/web/src/components/ui/react-bits` provide scroll reveals,
a quiet dot-grid backdrop, and a pointer-following stats card. The dashboard shell lazy-loads the
reveal component. Page headings and selected dashboard content opt in with `data-motion-*`
attributes; form controls and contract document text do not.

Nested areas that need native scrolling (dialogs, the sidebar, and long option lists) use
`data-lenis-prevent`. Animations translate horizontally in opposite directions for LTR and RTL.

To check manually, navigate between dashboard pages, scroll through the overview, open a long
dialog/list, and switch the OS/browser to reduced motion while the page is open. The latter should
stop smooth scrolling and leave the page static.
