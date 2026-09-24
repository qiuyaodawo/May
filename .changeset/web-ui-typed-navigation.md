---
"@may/web-ui": minor
---

Add typed sidebar navigation groups and lifecycle interfaces (`WebUiNavigationItem`, `WebUiNavigationGroup`, `WebUiNavigationLifecycle`, `WebUiNavigation`, `createNavigation`) to `WebUiOptions`, supporting custom icons, titles, badges, disabled predicates, and actions without direct DOM manipulation. Add `onNew` and `newLabel` callback hooks with typed context to customize the primary session/task creation action.

Enhance reading workbench responsiveness by avoiding layout measurements during active streaming following mode. Track block signature changes and approval mutations across snapshot updates to reliably trigger unread indicators even for equal-length content modifications. Clean up named scroll event listeners and cancel pending restore animation frames on teardown.

Improve responsive layouts and accessibility across 320 px, 390 px, 768 px, and 1440 px viewports. Provide an accessible mobile backdrop overlay (`.mobile-backdrop`) that blocks interaction with the main content. Apply `inert` and `aria-hidden` attributes to collapsed drawers, restore keyboard focus to trigger buttons on Escape or overlay dismissal, and provide explicit dialog titles.
