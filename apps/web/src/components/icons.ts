/**
 * The single icon vocabulary of the app (T³ UI & icon brief §9).
 *
 * Every markup entry is a hand-traced 24×24 outline drawing (2-unit stroke,
 * rounded caps and joins) cleaned up from the approved PNG masters in
 * apps/web/icon. The SVG is colored at runtime via `currentColor`; the black
 * masters only fix the shapes, never the rendered color.
 *
 * Semantics fixed by the user (2026-09):
 * - `view-count` is the approved bar-chart replacement for the eye master.
 * - `view-later` keeps the counter-clockwise return arrow; `history` is the
 *   plain clock face — the two must stay distinguishable at 20px.
 * - `view-later-check` keeps the same arrow body with a check replacing the
 *   clock hands (the "added to View later" state).
 */
export type IconName =
  | 'thumb-up'
  | 'view-count'
  | 'history'
  | 'view-later'
  | 'view-later-check'
  | 'shuffle'
  | 'reorder'
  | 'back'
  | 'arrow-up'
  | 'folder'
  | 'folder-plus'
  | 'search'
  | 'homepage'
  | 'exchange'
  | 'menu'
  | 'close'
  | 'edit'
  | 'settings'
  | 'sun'
  | 'moon'
  | 'expand'
  | 'collapse'
  | 'add'
  | 'delete'
  | 'layoutshift'
  | 'shelded'
  | 'unshelded';

export const iconMarkup: Record<IconName, string> = {
  'thumb-up':
    '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3Z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>',
  'view-count':
    '<rect x="4" y="12" width="4" height="8" rx="1.5"/><rect x="10" y="8" width="4" height="12" rx="1.5"/><rect x="16" y="4" width="4" height="16" rx="1.5"/>',
  'history':
    '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  'view-later':
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  'view-later-check':
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="m8.6 12.1 2.4 2.4 4.6-5"/>',
  'shuffle':
    '<path d="M16 3h5v5"/><path d="m4 20 17-17"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  'reorder':
    '<path d="M9 7h12"/><path d="m9 3-4 4 4 4"/><path d="M15 17H3"/><path d="m15 13 4 4-4 4"/>',
  'back':
    '<path d="M20 12H5"/><path d="m11 18-6-6 6-6"/>',
  'arrow-up':
    '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  'folder':
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"/>',
  'folder-plus':
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"/><path d="M12 10.5v6"/><path d="M9 13.5h6"/>',
  'search':
    '<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4-4"/>',
  // Traced from the approved master (apps/web/icon/homepage.png): a house outline whose eaves
  // overhang the walls, with a rounded door standing on the same floor line.
  'homepage':
    '<path d="M3.6 11.4 12 3.5l8.4 7.9"/><path d="M6 10.3V18a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-7.7"/><path d="M10 20v-4.3a1.5 1.5 0 0 1 1.5-1.5h1a1.5 1.5 0 0 1 1.5 1.5V20"/>',
  // Traced from the approved master (apps/web/icon/exchange.png): two shafts with opposite heads —
  // up on the left, down on the right. The pair is what says "move these past each other", so the two
  // halves are kept at the same length.
  'exchange':
    '<path d="M9 20V4"/><path d="m5.5 7.5 3.5-3.5 3.5 3.5"/><path d="M15 4v16"/><path d="m11.5 16.5 3.5 3.5 3.5-3.5"/>',
  'menu':
    '<path d="M4 7h16M4 12h16M4 17h16"/>',
  'close':
    '<path d="m6 6 12 12M18 6 6 18"/>',
  'edit':
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  'settings':
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  'sun':
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  'moon':
    '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>',
  // Traced from the approved masters (apps/web/icon/expand.png, collapse.png):
  // two chevrons of the `back` icon's geometry, tip to tip, reading as "widen"
  // and "narrow" the same strip.
  'expand':
    '<path d="M5.5 6l6 6-6 6"/><path d="M12 6l6 6-6 6"/>',
  'collapse':
    '<path d="M18.5 6l-6 6 6 6"/><path d="M12 6l-6 6 6 6"/>',
  'add':
    '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
  // Traced from apps/web/icon/delete.png; the master is the same X as `close`,
  // kept under its own semantic name for the media editors that use it.
  'delete':
    '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
  // Traced from the approved master (apps/web/icon/layoutshift.png): the two card shapes — the tall
  // one upper left, the wide one lower right — with a curved arrow between them in each direction.
  // That pair of arrows is the whole meaning ("these two change places"), so the portrait and the
  // landscape rectangle keep the same area and one arrow is the other's mirror.
  //
  // Laid out with more white space than the master shows, and drawn at the set's own 20px. The
  // master packs its four elements so tightly that its gaps are under a pixel at any toolbar size,
  // so a faithful trace renders as one solid shape — which is exactly what a first attempt did: the
  // walls of two rectangles plus a short arrow came out 1.7px apart and antialiased into a black
  // blob beside the set's open outlines. Four elements fit at 20px only if the arrows keep their
  // length (a stubby arrow is the blob) and nothing touches anything else.
  'layoutshift':
    '<rect x="2.5" y="2.5" width="7" height="11" rx="1.6"/><rect x="13" y="13" width="7.5" height="6" rx="1.6"/><path d="M13 5h4a3 3 0 0 1 3 3v1"/><path d="m17.5 7 2.5 2.5 2.5-2.5"/><path d="M11 20H7a3 3 0 0 1-3-3v-1"/><path d="m1.5 18.5 2.5-2.5 2.5 2.5"/>',
  // The two halves of the "can be hidden" state, traced from the approved masters
  // (apps/web/icon/shelded.png, unshelded.png): one shield, with a slash across it when the Gallery
  // is kept out of view and a check when it is not. Same shield path in both, so the pair reads as
  // one state changing rather than two unrelated pictures.
  'shelded':
    '<path d="M12 2.7 20.5 6.4v5.6c0 5.4-3.5 8.5-8.5 9.7-5-1.2-8.5-4.3-8.5-9.7V6.4Z"/><path d="m8.4 15.6 7.2-7.2"/>',
  'unshelded':
    '<path d="M12 2.7 20.5 6.4v5.6c0 5.4-3.5 8.5-8.5 9.7-5-1.2-8.5-4.3-8.5-9.7V6.4Z"/><path d="m7.6 12.6 3.5 3.5 6.5-7"/>',
};
