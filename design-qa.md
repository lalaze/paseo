# Collaboration picker design QA

final result: passed

## Visual target and evidence

Selected option 1: `/tmp/paseo-collaboration-dialog-qa/source.png` (original:
`/Users/lalaze/.codex/generated_images/01a0cd70-948e-7d41-a4fb-62d0b4816024/exec-d09bfdee-39f8-4fd8-9ac7-2c83490154f4.png`).

The generated reference is 1420 × 1108 pixels with an approximately 888px-wide modal.
It has no CSS viewport or device density. Compare its modal composition at the approved
560px width; exclude its blurred presentation canvas. Browser captures use DPR 1:
1280 × 720 CSS/pixels on desktop and 390 × 844 CSS/pixels on phone. Interaction checks
also cover 320 × 640. No pixel-difference score is claimed across these different canvases.

Evidence under `/tmp/paseo-collaboration-dialog-qa/`:

- `dark-missing-desktop.png`, `dark-missing-phone.png`: selected execution/review, missing reviewer, Chinese copy.
- `light-missing-desktop.png`, `light-missing-phone.png`: light theme.
- `skin-missing-desktop.png`, `skin-missing-phone.png`: imported bitmap skin with custom colors; opaque modal surfaces.
- `dark-long-phone.png`, `dark-expanded-phone.png`: three-line goal and expanded content with fixed footer.
- `dark-long-profiles-desktop.png`, `dark-long-profiles-phone.png`: wrapped configuration names after scrolling.

The reference and implementation were opened together for composition comparison.
The full desktop captures show the radio, role, and footer regions legibly; the scrolled
profile and phone captures provide focused wrapping/overflow evidence.

## Findings and fixes

- P2, phone: the initial 65% sheet clipped the reviewer helper in the ordinary state.
  Initial evidence: `/tmp/paseo-dialog-visual-results/collaboration-mode-picker--aa664-keyboard-navigation-in-dark-browser/dark-missing-phone.png`.
  Set this picker's initial snap point to 75%, retaining the existing 90% expanded point.
  Post-fix `dark-missing-phone.png` shows the entire helper above the footer.
- P2, goal expansion: the shared button's accessibility state did not emit web `aria-expanded`.
  Add explicit `aria-expanded`, retain native state, and use a 44px button on compact layouts.
  Browser assertions check expansion and touch height. Clip hidden measurement content so it
  cannot extend the collapsed scroll area.
- P1, resizing: a bottom-sheet dismissal could close the desktop replacement during a layout
  transition. Defer the notification until the responsive commit, ignore unmounted sheets,
  reset disabled sheet lifecycle state, and scope picker close callbacks to their request.
  The browser now preserves the open picker through desktop → phone → narrow phone → desktop;
  a tracker regression test also verifies disabling and re-enabling the sheet.
- P2, keyboard: React Native Web's Pressable consumes its own key handler and does not activate
  radio roles with Space; the app-wide voice shortcut also intercepted that key. Classify
  custom radios as form controls and handle Space on their containing View. Arrow/Home/End
  handling stays on the group. The final browser run passes Space, arrows, focus and checked state.

## Fidelity review

- Typography: retained the app's font stack, Chinese fallback, 14px primary and 12px secondary
  tokens, and existing sheet/section heading primitives. These are intentionally smaller and
  less bold than the generated reference, as required by the approved reuse of existing styles.
- Layout: 560px maximum desktop width, 24px content inset, stacked full-width radio choices,
  aligned role/value columns, and a separate fixed footer. Long content scrolls; role values wrap.
- Colors: theme surfaces and foreground tokens remain opaque. Selection uses a lighter surface
  and visible border; missing reviewer uses the warning token. The primary CTA uses the app's
  accent rather than the reference's white fill. Skin evidence uses the repository icon bitmap,
  not the user's personal wallpaper.
- Assets: existing Lucide radio/user/shield/chevron icons; no new decorative raster assets or
  approximation of the user's background. Icons remain sharp at DPR 1.
- Copy: approved Chinese mode descriptions, task-only subtitle, missing-reviewer helper,
  management entry and state-dependent CTA. New strings are present in all nine locale files.

## Verification and limits

- Existing six collaboration browser cases passed: settings save/return, invalid settings,
  cancellation, retained draft/goal/mode, command entry points and conversation creation.
- Three visual/browser cases cover dark, light and imported skin, radio semantics, focus,
  keyboard selection, fixed footer, long goals/names, phone touch sizes and responsive switching.
  Browser page-error listeners assert no uncaught exceptions; development-tool warnings remain
  in the test logs. No blanket console-error filtering was added.
- Targeted unit tests: eight settings/launch model cases, five sheet layout cases and eleven
  sheet lifecycle cases, plus four keyboard focus-scope cases. Models cover missing settings/reviewer, pending duplicate prevention,
  retry, old-host capability and fixed task mode.
- Workspace client declarations were built. Repository typecheck, lint and formatting are checked.
- No iOS/Android native device, native screen reader, Electron package or translated-language
  layout matrix was exercised. Chromium screenshots cover web desktop/phone layouts.

No remaining visual P0/P1/P2 findings after the documented fixes. Final keyboard verification
passed; no further P3 styling changes are required for this scope.
