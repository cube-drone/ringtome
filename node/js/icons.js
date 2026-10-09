// The icon vocabulary: one place mapping what a thing MEANS to its glyph, so the rest of the UI
// names icons by role (`Icons.pin`, `Icons.trash`) and the drawing is decided here - swap a glyph
// once and every use follows. Phosphor Icons (MIT, open-source), rendered DUOTONE via the
// `IconContext` provider set at the app root: the default weight lives there, so a bare
// `<${Icons.pin} />` comes out duotone, in `currentColor`, sized to its container's font
// (Phosphor's default size is 1em - the reason the old emoji's font-size rules still size these).
import {
    Archive,
    Books,
    Scroll,
    PiggyBank,
    CrownSimple,
    Rss,
    Bank,
    ChartLine,
    ChatsCircle,
    Funnel,
    Path,
    NotePencil,
    PushPin,
    Biohazard,
    Copy,
    CaretLeft,
    X,
    UserCircle,
    UserSwitch,
    IdentificationCard,
    Gear,
    Desktop,
    HardDrives,
    PaintBrush,
    Hand,
    PaintBucket,
    List,
    Eyedropper,
    MagnifyingGlassPlus,
    MagnifyingGlassMinus,
    ImageSquare,
    LineSegment,
    Rectangle,
    BoundingBox,
    Crop,
    TextAlignLeft,
    TextAlignCenter,
    TextAlignRight,
    DownloadSimple,
    AppleLogo,
    AndroidLogo,
    WindowsLogo,
    LinuxLogo,
    Info,
    SlidersHorizontal,
    Notebook,
    FloppyDisk,
    Circle,
    Stack,
    Eraser,
    Laptop,
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
    PaperPlaneRight,
    Smiley,
    Eye,
    EyeClosed,
    Memory,
    SignOut,
    CaretDown,
    SpeakerSlash,
    Siren,
    CheckCircle,
    LinkSimple,
    FileImage,
    FileAudio,
    FileVideo,
    UsersThree,
    SignIn,
    House,
    Question,
    Package,
    Sticker,
    Hash,
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
    Prohibit,
    HandPalm,
    Detective,
    GlobeHemisphereWest,
    Swap,
    ArrowCounterClockwise,
    EyeSlash,
    BookOpen,
    Robot,
    TerminalWindow,
    ArrowElbowRight,
    Waveform,
    Image as ImageGlyph,
    Video,
    Resize,
    ArrowsIn,
    ArrowsInSimple,
    ArrowsOut,
    ShieldSlash,
    Cloud,
    Graph,
    ArrowsClockwise,
    FileCloud,
    CloudArrowDown,
    CloudArrowUp,
    CloudSun,
} from '@phosphor-icons/react';

export { IconContext } from '@phosphor-icons/react';

export const Icons = {
    // The corner cloud's faces (plans/SYNC_STATUS.md, piece 3; synccloud.js).
    syncIdle: Cloud,
    syncDown: CloudArrowDown,
    syncUp: CloudArrowUp,
    syncSun: CloudSun,
    // Your computers' own page (2026-10-09): each computer in the persona's tree, the sync-now
    // button, and the sync report.
    computerNode: Graph,
    syncNow: ArrowsClockwise,
    syncReport: FileCloud,
    // apps (the console tiles + each app's own header)
    persona: UserCircle,
    // Your own reach, on your own page (2026-09-28): public follows and fetches.
    stats: ChartLine,
    personas: UserSwitch,
    notes: NotePencil,
    // actions and chrome
    pin: PushPin,
    // Content control (2026-09-07): the blur and hide lists, under your settings.
    biohazard: Biohazard,
    // Copy into private notes (2026-09-08).
    copy: Copy,
    back: CaretLeft,
    forward: CaretRight,
    plus: Plus,
    close: X,
    tag: Tag,
    // What a post was made with (made_with.rs, plans/MCP.md _Provenance_, 2026-10-06): the author's
    // own `ai-agent` and `api-key` tags wear these on the feed's label chips.
    aiAgent: Robot,
    apiKey: TerminalWindow,
    // Tags and kinds whose meaning is fixed wear these, in the facet rows and on the label chips
    // (pure/tagicons.js; Curtis, 2026-10-06). "me" is the reader's own posts.
    me: UserCircle,
    kindPost: Megaphone,
    kindReply: ArrowElbowRight,
    kindRebroadcast: CellTower,
    kindBook: Books,
    kindRoom: ChatsCircle,
    mediaAudio: Waveform,
    mediaImage: ImageGlyph,
    mediaVideo: Video,
    sizeMicro: Resize,
    sizeShort: ArrowsIn,
    sizeMedium: ArrowsInSimple,
    sizeLong: ArrowsOut,
    // The content warnings (pure/warnings.js `DEFAULT_BLUR`): the explicit ones, and the harmful.
    warnExplicit: Detective,
    warnHarm: ShieldSlash,
    trash: Trash,
    lock: Lock,
    key: Key,
    signIn: SignIn,
    // The front door itself, from anywhere a stranger has wandered (2026-09-28: the desktop app
    // has no back button, so a link followed from the front page was a one-way trip).
    home: House,
    // The front door's other two tabs (2026-09-28): new here, and bringing a user from elsewhere.
    newHere: Question,
    importUser: Package,
    // the front page's Download tab (2026-09-29): one button per system
    appleLogo: AppleLogo,
    windowsLogo: WindowsLogo,
    linuxLogo: LinuxLogo,
    androidLogo: AndroidLogo, // since 0.3.1 shipped an APK (2026-10-09)
    profile: IdentificationCard,
    settings: Gear,
    computers: Desktop,
    // Import/export (plans/EXPORT.md): the persona, whole, as one zip.
    exportPersona: Package,
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
    // The notebook in view, heading its app's list (buckets.js BucketSwitcher).
    bucketOpen: FolderOpen,
    sectionNew: FolderSimplePlus,
    rename: PencilSimple,
    // collapsible column rails
    list: ListBullets,
    // A narrow window's menu of a document's chips (doc/editor.js `deck`).
    menu: List,
    tree: TreeStructure,
    // document prev/next (the book-walk arrows in the doc menu)
    navPrev: ArrowLeft,
    navNext: ArrowRight,
    // file upload (the doc-menu button; drop and paste land in the same place)
    upload: UploadSimple,
    // say it: the chat composer's send
    send: PaperPlaneRight,
    // answer a line with an emoji (CHAT.md, slice 9)
    smiley: Smiley,
    // the room header's tools (Curtis, 2026-09-19): see / hide untrusted speakers, keep the
    // whole history here, leave; the post is the megaphone (`feed`), close the prohibit
    // (`settled`), delete the trash
    eye: Eye,
    eyeClosed: EyeClosed,
    memory: Memory,
    leave: SignOut,
    caretDown: CaretDown,
    // the room's moderation (CHAT.md, ruling 8): the creator's mute
    mute: SpeakerSlash,
    // ...and a private chat's one power (ruling 12): the raised hand that ends it.
    block: HandPalm,
    // ...and the badge that lets somebody else do it (ruling 8's moderators list)
    deputy: Siren,
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
    // hrseBank™ (2026-09-29)
    bank: PiggyBank,
    // a node administrator's pin to the server's front page (frontdoor.js, 2026-09-30)
    superPin: CrownSimple,
    // a person's RSS, in their page's top right corner (rss.rs, 2026-09-30)
    rss: Rss,
    // a hrseBond in the market: the treasury's columns (2026-09-30)
    bond: Bank,
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
    // A post with rebroadcast and comment turned off (PROJECT_PLAN's Post visibility).
    settled: Prohibit,
    // A document's standing in public (PUBLISH.md ruling 6): private, public - and
    // `scheduled` above is the third.
    docPrivate: Detective,
    docPublic: GlobeHemisphereWest,
    // The publish bar's verbs (PUBLISH.md): say the changes again; take it back.
    update: Swap,
    unpublish: ArrowCounterClockwise,
    // A notebook published as a book (PROJECT_PLAN's Books): the column and a hidden mark; a page never
    // rolled out wears `pageNew` above.
    book: BookOpen,
    // A book's title page, pinned above every pin in its notebook's list (2026-10-02).
    titlePage: Books,
    // A contract in hrseBank (2026-10-04): a goal that pays once.
    contract: Scroll,
    hidden: EyeSlash,
    // The upload window's description field (doc/upload.js): it is the alt text, for the people who
    // can't see the picture - the eye-slash says who it's for.
    altText: EyeSlash,
    // Rooms (CHAT.md): the app tile, and the chip a room post wears.
    chat: ChatsCircle,
    // A room, beside its title (2026-09-28): the hash, as a channel is marked.
    room: Hash,
    // The place's own settings (apps/device.js): a rack of drives for a server, a laptop for
    // the desktop app - the app wears whichever the person is holding.
    server: HardDrives,
    device: Laptop,
    // Drawing (DRAWING.md): the app tile and the brush tool share the brush; the eraser is its own.
    drawing: PaintBrush,
    eraser: Eraser,
    // ...and its layers column: a stack of sheets; and the grab tool, which moves a whole layer.
    layers: Stack,
    grab: Hand,
    // ...and the paint bucket, which pours; and the eyedropper, which picks a colour up.
    bucket: PaintBucket,
    eyedropper: Eyedropper,
    // ...and the navigator's zoom.
    zoomIn: MagnifyingGlassPlus,
    zoomOut: MagnifyingGlassMinus,
    // ...and a picture brought in from the person's media.
    addImage: ImageSquare,
    // ...and the shapes, dragged out corner to corner.
    line: LineSegment,
    rectangle: Rectangle,
    ellipse: Circle,
    // ...and the transform, which turns, stretches and slants a whole layer.
    transform: BoundingBox,
    // ...and the crop, which cuts the canvas down.
    crop: Crop,
    // ...and its cousins, which frame a picture as your profile picture or your banner.
    asProfile: UserCircle,
    asBanner: IdentificationCard,
    // ...and stickers, stamped from a shelf of pictures (2026-09-28).
    sticker: Sticker,
    // ...and text, with its alignments.
    text: TextT,
    alignLeft: TextAlignLeft,
    alignCenter: TextAlignCenter,
    alignRight: TextAlignRight,
    // ...and a drawing saved as a picture file.
    download: DownloadSimple,
    // The house tooltip's glyph (tooltip.js).
    info: Info,
    // Application settings, in your settings (persona.js).
    appSettings: SlidersHorizontal,
    // A notebook (a bucket, a sketchbook), where one is named as a filter (doc/imagepick.js).
    notebook: Notebook,
    // ...and the files notebook, hrseFiles's, which is a disk rather than a book.
    filesBucket: FloppyDisk,
};

/// The glyph an app's registry entry names. The registry (pure/apps.js) carries a role name rather than
/// a component so that it can stay import-free and testable; this is where the name becomes a
/// drawing. An unknown name degrades to the page glyph rather than crashing a render - and
/// integration/test/pure/apps.cjs asserts no registry entry actually relies on that.
///
/// `device` is true in the desktop app, where an app with a `deviceIcon` wears it instead.
export const iconFor = (app, device = false) =>
    (app && device && app.deviceIcon && Icons[app.deviceIcon]) ||
    (app && Icons[app.icon]) ||
    Icons.page;

/// The icon a MEDIA document's format earns in listings (tree rows, the note picker), or null
/// for text formats - text rows keep their default look. Wire names from the server's
/// `Format::as_str`: avif/apng render as images, webm as video, opus as audio.
export const formatIcon = (format) =>
    ({
        avif: Icons.fileImage,
        apng: Icons.fileImage,
        webm: Icons.fileVideo,
        opus: Icons.fileAudio,
        drawing: Icons.drawing,
    })[format] || null;
