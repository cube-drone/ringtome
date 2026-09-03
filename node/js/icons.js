// The icon vocabulary: one place mapping what a thing MEANS to its glyph, so the rest of the UI
// names icons by role (`Icons.pin`, `Icons.trash`) and the drawing is decided here - swap a glyph
// once and every use follows. Phosphor Icons (MIT, open-source), rendered DUOTONE via the
// `IconContext` provider set at the app root: the default weight lives there, so a bare
// `<${Icons.pin} />` comes out duotone, in `currentColor`, sized to its container's font
// (Phosphor's default size is 1em - the reason the old emoji's font-size rules still size these).
import {
    Archive,
    Funnel,
    Path,
    NotePencil,
    PushPin,
    CaretLeft,
    X,
    UserCircle,
    IdentificationCard,
    Desktop,
    HandWaving,
    Tag,
    Trash,
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
    CheckCircle,
    LinkSimple,
    FileImage,
    FileAudio,
    FileVideo,
    UsersThree,
    CellSignalNone,
    CellSignalLow,
    CellSignalMedium,
    CellSignalHigh,
    CellSignalFull,
    SpeakerSimpleX,
    IdentificationBadge,
    Broadcast,
    CellTower,
    Globe,
    LockSimple,
    Megaphone,
    Bell,
    ClockCountdown,
} from '@phosphor-icons/react';

export { IconContext } from '@phosphor-icons/react';

export const Icons = {
    // apps (the console tiles + each app's own header)
    persona: UserCircle,
    notes: NotePencil,
    // actions and chrome
    pin: PushPin,
    back: CaretLeft,
    forward: CaretRight,
    plus: Plus,
    close: X,
    tag: Tag,
    trash: Trash,
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
    // the document tree (sections are taxonomies, pages are documents) - Writer's right column
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
    done: CheckCircle,
    // media document kinds (tree rows, list rows)
    fileImage: FileImage,
    fileAudio: FileAudio,
    fileVideo: FileVideo,
    // the copy-a-cozy-link chip
    link: LinkSimple,
    // the search-options dropdown (the funnel beside the search box)
    filter: Funnel,
    // Lost & Found: the app tile, and follow-me-home on each row. A lidded crate - the
    // lost-property box, not a filing cabinet, because you come here having mislaid something.
    lostFound: Archive,
    people: UsersThree,
    feed: Megaphone,
    notifications: Bell,
    // the People table's vocabulary: signal bars for the graded dials, and the rest
    signal0: CellSignalNone,
    signal1: CellSignalLow,
    signal2: CellSignalMedium,
    signal3: CellSignalHigh,
    signal4: CellSignalFull,
    blockedSpeaker: SpeakerSimpleX,
    colTrust: IdentificationBadge,
    colInterest: Broadcast,
    colRebroadcast: CellTower,
    trustPublic: Globe,
    trustPrivate: LockSimple,
    path: Path,
    // A post waiting for its day (PUBLISH.md): the clock counting down.
    scheduled: ClockCountdown,
};

/// The glyph an app's registry entry names. The registry (pure/apps.js) carries a role name rather than
/// a component so that it can stay import-free and testable; this is where the name becomes a
/// drawing. An unknown name degrades to the page glyph rather than crashing a render - and
/// integration/test/pure/apps.cjs asserts no registry entry actually relies on that.
export const iconFor = (app) => (app && Icons[app.icon]) || Icons.page;

/// The icon a MEDIA document's format earns in listings (tree rows, the note picker), or null
/// for text formats - text rows keep their default look. Wire names from the server's
/// `Format::as_str`: avif/apng render as images, webm as video, opus as audio.
export const formatIcon = (format) =>
    ({
        avif: Icons.fileImage,
        apng: Icons.fileImage,
        webm: Icons.fileVideo,
        opus: Icons.fileAudio,
    })[format] || null;
