// The icon vocabulary: one place mapping what a thing MEANS to its glyph, so the rest of the UI
// names icons by role (`Icons.pin`, `Icons.gear`) and the drawing is decided here - swap a glyph
// once and every use follows. Phosphor Icons (MIT, open-source), rendered DUOTONE via the
// `IconContext` provider set at the app root: the default weight lives there, so a bare
// `<${Icons.pin} />` comes out duotone, in `currentColor`, sized to its container's font
// (Phosphor's default size is 1em - the reason the old emoji's font-size rules still size these).
import {
    NotePencil,
    CookingPot,
    Notebook,
    Books,
    Megaphone,
    BookOpen,
    PushPin,
    Gear,
    CaretLeft,
    X,
    UserCircle,
    IdentificationCard,
    Desktop,
    HandWaving,
} from '@phosphor-icons/react';

export { IconContext } from '@phosphor-icons/react';

export const Icons = {
    // apps (the console tiles + each app's own header)
    persona: UserCircle,
    notes: NotePencil,
    recipes: CookingPot,
    journal: Notebook,
    wiki: Books,
    blog: Megaphone,
    book: BookOpen,
    // actions and chrome
    pin: PushPin,
    gear: Gear,
    back: CaretLeft,
    close: X,
    profile: IdentificationCard,
    computers: Desktop,
    logout: HandWaving,
};
