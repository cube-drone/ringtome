// A room's title, marked as a room (Curtis, 2026-09-28): a `#` before it wherever it stands on its own
// - the room list, a room's head, a room's card in the feed. A private chat for two is titled with the
// other person, and a person wears no `#`. Where a room's icon already sits beside the title, the icon
// (Phosphor's hash, `Icons.room`) is the mark, and the title goes bare.
import { h } from 'preact';
import htm from 'htm';

const html = htm.bind(h);

export const RoomTitle = ({ children }) => html`<span class="room-title"><span class="room-hash" aria-hidden="true">#</span>${children}</span>`;
