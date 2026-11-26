// How j and k reach the list column. The list on show registers how it moves focus, since a long
// list draws only the rows in view and has to scroll to the next one first.

type Mover = (delta: 1 | -1) => void;

let mover: Mover | null = null;

/** Registers the list on show. Returns what unregisters it. */
export function setListMover(next: Mover): () => void {
  mover = next;
  return () => {
    if (mover === next) mover = null;
  };
}

/** Moves focus one row down or up. False when no list shows. */
export function moveInList(delta: 1 | -1): boolean {
  if (!mover) return false;
  mover(delta);
  return true;
}

/** The id of the list column's search field, which `/` focuses. */
export const FILTER_ID = "list-filter";

/** The id of the list column, so a key that belongs to it, such as Escape, can tell it is there. */
export const COLUMN_ID = "list-column";

/** Focuses an element once it renders, such as the search field of a list column that opens now. */
export function focusSoon(id: string, tries = 4): void {
  const el = document.getElementById(id);
  if (el) {
    el.focus();
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusSoon(id, tries - 1));
}
