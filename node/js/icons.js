// The icon vocabulary: one place mapping what a thing MEANS to its glyph, so the rest of the UI
// names icons by role (`Icons.pin`, `Icons.gear`) and the drawing is decided here - swap a glyph
// once and every use follows. Phosphor Icons (MIT, open-source), rendered DUOTONE via the
// `IconContext` provider set at the app root: the default weight lives there, so a bare
// `<${Icons.pin} />` comes out duotone, in `currentColor`, sized to its container's font
// (Phosphor's default size is 1em - the reason the old emoji's font-size rules still size these).
import {
    NotePencil,
    CookingPot,
    PenNib,
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
    Tag,
    Trash,
    Skull,
    Lock,
    Key,
    FloppyDiskBack,
    SpinnerGap,
    WarningCircle,
    GitPullRequest,
    GitMerge,
    ArticleMedium,
    SquareHalf,
    TextT,
    TextTSlash,
    Keyboard,
    TextAa,
    Plus,
    CaretRight,
    FileText,
    FilePlus,
    FolderSimple,
    FolderOpen,
    FolderSimplePlus,
    PencilSimple,
    ListBullets,
    TreeStructure,
    ArrowLeft,
    ArrowRight,
    UploadSimple,
} from '@phosphor-icons/react';

export { IconContext } from '@phosphor-icons/react';

export const Icons = {
    // apps (the console tiles + each app's own header)
    persona: UserCircle,
    notes: NotePencil,
    recipes: CookingPot,
    journal: PenNib,
    wiki: Books,
    blog: Megaphone,
    book: BookOpen,
    // actions and chrome
    pin: PushPin,
    gear: Gear,
    back: CaretLeft,
    forward: CaretRight,
    plus: Plus,
    close: X,
    tag: Tag,
    trash: Trash,
    debug: Skull,
    lock: Lock,
    key: Key,
    profile: IdentificationCard,
    computers: Desktop,
    logout: HandWaving,
    // editor status + document format (icon-only chips; the tooltip carries the words)
    saved: FloppyDiskBack,
    spinner: SpinnerGap,
    warn: WarningCircle,
    conflict: GitPullRequest,
    merged: GitMerge,
    formatMarquee: ArticleMedium,
    formatPlain: TextT,
    // editor view modes (icon-only tabs; names live in the tooltip)
    modeInteractive: ArticleMedium,
    modeSide: SquareHalf,
    modePlain: TextT,
    modeRead: TextTSlash,
    // journal font override
    fontTypewriter: Keyboard,
    fontHand: PenNib,
    fontLegible: TextAa,
    // the wiki tree (sections are taxonomies, pages are documents)
    page: FileText,
    pageNew: FilePlus,
    section: FolderSimple,
    sectionOpen: FolderOpen,
    sectionNew: FolderSimplePlus,
    rename: PencilSimple,
    // collapsible column rails
    list: ListBullets,
    tree: TreeStructure,
    // document prev/next (the book-walk arrows in the doc menu)
    navPrev: ArrowLeft,
    navNext: ArrowRight,
    // file upload (the doc-menu button; drop and paste land in the same place)
    upload: UploadSimple,
};
