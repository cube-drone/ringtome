# Signing Horse Drawing Tycoon 2 — the paperwork, in order

Everything in here is Curtis's to do, because it is identity and money rather than code. It exists
because both processes involve **real-world waiting** — Apple verifies a human, Microsoft verifies a
human, and neither is in a hurry — so the point of this document is to get the clocks started in the
right order and let the unsigned build carry on meanwhile.

[DESKTOP.md](DESKTOP.md)'s Stage 4 is what this unblocks. Nothing here blocks Stages 1–3, which are
built, or the unsigned artifacts, which the CI matrix produces without a single certificate.

**What signing buys, stated plainly, so the money is spent knowingly:** on macOS it is the
difference between an app that opens and one that says "Horse Drawing Tycoon 2 is damaged and can't be opened",
which is what Gatekeeper tells a user about unsigned software downloaded from the web. On Windows it
is the difference between SmartScreen's blue wall and a normal install — *eventually*: an OV
certificate, which is what both of these are, earns its reputation over downloads rather than
arriving with it. Only an EV certificate (hardware token, several hundred a year) silences
SmartScreen from the first download, and that is not what we are buying.

---

## 0. First, the free one — do this today

The updater's signing key is **ours**, costs nothing, and is the one secret in this document that
cannot be replaced. If it is lost, no installed copy of Horse Drawing Tycoon 2 can ever update itself again; there
is no recovery, because the public half is baked into every binary already shipped.

The command lives in Tauri's CLI, which is a separate install - and one Stage 4 needs regardless,
since `cargo tauri build` is what produces the `.dmg` and the Windows installers:

```sh
cargo install tauri-cli --version "^2.0"     # a few minutes of compiling, once
cargo tauri signer generate -w ~/.ringtome/updater.key
```

(Or, to avoid installing anything today: `npx @tauri-apps/cli@2 signer generate -w ~/.ringtome/updater.key`.)

It prints a **public key** (goes in `tauri.conf.json`, in the repo, public by design) and writes a
**private key** (never in the repo). Put the private key wherever your important secrets live — a
password manager, not a folder called `keys` — and treat losing it as equivalent to losing the
domain.

**On the key's own password, which is optional and which we skipped (Curtis, 2026-09-22):** "there's
a near 100% chance I'd be storing that password right next to the signing key", which is correct
reasoning about the threat it usually gets sold against. Two secrets in one vault are one secret, and
the same holds in CI, where the password would be a second repository secret beside the first. What a
password actually protects is the key FILE, in the places the file exists and the vault does not —
the copy in `~/.ringtome/`, a backup that swept it up, a sync client, anything running as you. The
cheaper version of that protection, given the vault already holds the key: **delete the file** and
paste it back when a release needs it.

The one operational consequence: a passwordless key still wants the variable to EXIST in any
non-interactive build, or the bundler can stop to ask for a password nothing is there to type. Set
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""` — empty, present — in CI and in any scripted release.
**GitHub will not store an empty secret**, and should not have to: an empty password is not a
secret, so it goes in the workflow's own `env:` block as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ''`
rather than in the secret store.

**And if you would rather have a password after all: regenerate NOW.** Key rotation is free today
and permanently expensive later, because it is free exactly until the first binary ships carrying
the public half — after that, changing keys means releasing a version signed with the OLD key that
carries the new public one, and anybody who misses that release reinstalls by hand. Nothing has
shipped. Today the whole cost is pasting a new public key into `tauri.conf.json`.

### ...and how CI gets at it

**As it stands (2026-09-22):** the keypair exists, the private half is in Curtis's password manager
and at `~/.ringtome/updater.key` on his machine, the public half is `~/.ringtome/updater.key.pub` and
belongs in `tauri.conf.json` when the updater is wired. Both secrets are set in a GitHub
**Environment named `deploy`**, which is the arrangement the release workflow will target
(`environment: deploy` on the job).

Worth setting on that environment while it is new, if it is not already: restrict it to the default
branch, and add a required reviewer. An Environment's value is precisely that secrets are not handed
to every workflow run that asks - without a protection rule it is a folder with a nice name.

Two secrets, when the release workflow exists: `TAURI_SIGNING_PRIVATE_KEY` (the file's contents -
multiline is fine) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The bundler reads them while building
updater artifacts and writes the `.sig` files the manifest points at.

Scope them narrowly, because a secret is readable by any workflow run that can see it: a release
workflow triggered by a tag on the default branch, ideally behind a GitHub **Environment** with
required approval. Fork pull requests get no secrets by default - leave that alone.

**Or keep the key off GitHub entirely.** The updater signature does not have to happen in CI: the
matrix can build unsigned artifacts and you can sign the manifest locally at release time. It costs
one manual step per release and removes the question of who can read the key. For a project with one
releaser, that is a defensible default, and it is the one to take while release cadence is low.

### If the key ever leaks

Worth reading once now, when it is theoretical. Every shipped binary carries the PUBLIC half, so a
new key is not something you can simply start using - an app signed with a key the installed copies
do not know will not verify, and those copies are the ones that need the update.

The procedure is therefore: mint the new keypair, put its public half in `tauri.conf.json`, and
release that version **signed with the OLD key** - which installed copies still trust. As users take
that update they move onto the new key, and only then does the old one stop mattering. Which means
the rotation has to happen while the old key still WORKS, and the worst case is not "the key leaked"
but "the key leaked and we did not notice for a year". Anyone still on an older version at that point
has to reinstall by hand.

The corollary, said plainly: an attacker with this key still needs to control the endpoint the app
polls in order to deliver anything, so a leak is not an instant compromise. It is a clock starting.

---

## 1. Apple — $99/yr, start it first (it is the long pole)

### What to sign up for

[developer.apple.com/programs](https://developer.apple.com/programs/) — the Apple Developer Program,
$99/yr. Enrol as an **individual** unless there is a company to enrol: an organisation needs a D-U-N-S
number and adds weeks. Individual enrolment is usually a day or two, sometimes same-day, occasionally
a week if their identity check wants a second look.

### What to create once you are in

1. **A "Developer ID Application" certificate.** Not "Mac App Distribution" — Developer ID is the one
   for software distributed outside the App Store, which is us. Only the *Account Holder* can create
   the first one, which is you.

   The portal asks two things that are easy to stall on (Curtis, 2026-09-22):

   - **Intermediary: G2 Sub-CA.** "Previous Sub-CA" exists only for signing with Xcode-11.4-era
     tooling and its certificates expire Feb 1 2027 anyway. The two lines are radio buttons — the
     Continue button stays greyed out until one is actually selected.
   - **A Certificate Signing Request, and Xcode is not needed for it.** Keychain Access makes one:
     *Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority*,
     your Apple ID email as the user email, your name as the Common Name (it becomes
     `Developer ID Application: Your Name (TEAMID)`), CA email blank, **Saved to disk**. Upload the
     `.certSigningRequest`, download the `.cer`, double-click to install.

   The Continue button stays greyed out until the CSR file is chosen - the intermediary radio and
   the file picker are on the same screen.

   The invisible half: that CSR **generates a private key in your login keychain**, and the
   certificate is worthless without it. That pair is what step 2 exports. Wipe the keychain before
   exporting and you start over with a new certificate.

   **"Tied to your machine" is a misreading worth clearing up**, because the whole CI story depends
   on it: a CSR binds the certificate to a KEY, not to hardware. There is no machine attestation
   anywhere in this. The key simply lives in the keychain that made it, and it travels the way keys
   travel - as a `.p12` holding both halves, which is why that export asks for a password. The `.cer`
   Apple hands back is the public half alone and cannot sign anything by itself.
2. **Export it as a `.p12`** from Keychain Access (**My Certificates**, right-click the
   *Developer ID Application* entry → Export, choose a password you will keep). Exporting from
   anywhere that offers no private key means you are exporting the public half alone, which signs
   nothing.

   Then confirm the identity is real and learn its exact name, which is what the signing
   configuration wants character for character:
   ```sh
   security find-identity -v -p codesigning
   #  1) A1B2... "Developer ID Application: Your Name (TEAM1D2345)"
   ```
   The quoted string is `APPLE_SIGNING_IDENTITY`; the part in parentheses is the Team ID. "0 valid
   identities found" means the certificate never landed in this keychain - double-click the `.cer`
   (or the `.p12`) and look again.

   And base64 it for CI:
   ```sh
   openssl base64 -A -in certificate.p12 -out certificate-base64.txt
   ```
   Then the `.p12` and its password go in the password manager and the loose copies get deleted; the
   keychain keeps a working copy for signing locally.
3. **An App Store Connect API key for notarization.** App Store Connect → Users and Access →
   Integrations / Keys → App Store Connect API → Generate. You get an **Issuer ID** (top of the
   page, shared by all your keys), a **Key ID** (on the row), and a `.p8` file **you can only
   download once** - lose it and the answer is to revoke and regenerate.

   (The alternative is your Apple ID plus an app-specific password, which works and is simpler, but
   ties CI to your personal account's password lifecycle. Prefer the API key.)

   **What notarization actually is**, since the word suggests a lawyer: signing is your claim about
   who built this and that it has not been altered, and Apple is not involved in it. Notarization is
   Apple's own automated check - upload the signed build, their service scans it for malware and for
   unsafe configuration, and on a pass issues a **ticket**, a receipt that Apple examined this exact
   binary. It is not App Store review: no human, no rules about what the app does, minutes rather
   than days. **Stapling** then attaches the ticket to the `.dmg` so a Mac can verify it offline.

   What it buys: since macOS 10.15, software downloaded from the web must be signed AND notarized,
   or the first launch says *"cannot be opened because Apple cannot check it for malicious
   software"* - the dialog with no obvious way forward, which is what friends and family would hit.
   With it, an ordinary "downloaded from the internet, are you sure?" once.

   The trade, stated so it is a decision rather than a surprise: the ticket is also a kill switch.
   A build later found malicious can have its ticket revoked, and Macs stop opening it. That is the
   same authenticated relationship that makes notarization need an ACTIVE membership - see *When you
   can stop paying*.

   **What to do with the three things it gives you.** The Key ID is on the key's row; the Issuer ID
   is the UUID above the list, shared by every key you make, and it is the one people scroll past.
   The `.p8` becomes a secret by way of base64:
   ```sh
   openssl base64 -A -in AuthKey_XXXXXXXX.p8 -out apikey-base64.txt
   ```
   → `APPLE_API_ISSUER` (the UUID), `APPLE_API_KEY` (the Key ID), `APPLE_API_KEY_BASE64` (that file).

   **Vault the `.p8` before deleting anything**: it downloads once, so the password manager's copy
   becomes the only copy in the world. Save it, check the save, then clear Downloads.

   **Then prove the three work together**, before any build depends on them:
   ```sh
   xcrun notarytool history --key AuthKey_XXXXXXXX.p8 --key-id <key id> --issuer <issuer uuid>
   ```
   An empty history is a pass - it authenticated. An error here is much cheaper to find now than in
   the middle of a release.

### What that turns into

| secret | what it is |
|---|---|
| `APPLE_CERTIFICATE` | the base64 of the `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you chose when exporting |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_API_ISSUER` | the Issuer ID |
| `APPLE_API_KEY` | the Key ID |
| `APPLE_API_KEY_PATH` | a path - so the secret is the `.p8`'s **base64** (`APPLE_API_KEY_BASE64`), which the workflow writes to a file and points this at |

Notarization is a round trip to Apple on every release build — it uploads the app, waits for a
verdict, and staples the result. It usually takes a few minutes and occasionally much longer; that is
a normal part of a release, not a fault.

### When signing fails and the certificate is fine

One failure worth recognising, because it reads as catastrophe and is not (2026-09-22, on the first
real bundle):

```
Signing with identity "Developer ID Application: ..."
... timestamps differ by 669 seconds - check your system clock
Error failed to bundle project: failed codesign application
```

`codesign` asks Apple's timestamp authority for a secure timestamp - notarization requires one - and
refuses when the local clock disagrees with it by too much. Nothing is wrong with the certificate,
the keychain or the configuration. Fix the clock (System Settings → General → Date & Time → Set
automatically) and run it again; the retry signed cleanly, `Authority=Developer ID Application`
chaining to `Apple Root CA`.

---

## 2. Azure Artifact Signing (formerly Trusted Signing) — ~$10/mo

The cheapest Windows path that does not involve a physical USB token, which matters because a token
cannot sign from CI without a machine of our own to plug it into.

### Before you start, two eligibility facts

- **Individual validation is available only to developers located in the United States or Canada.**
- It reads your identity from the **Azure billing account**, which must have Account Type =
  *Individual*, and whose legal name and address must **match your government ID exactly**. Fix the
  billing account first; a mismatch means starting the validation over.

### The steps

1. An **Azure subscription** and a Microsoft Entra tenant (creating a subscription makes one).
2. In the portal, register the **`Microsoft.CodeSigning`** resource provider for that subscription.
3. Create an **Artifact Signing account** — pick a region near you (`West US 2`, `Central US`,
   `East US`… the region determines the endpoint URI we will need later) and the **Basic** tier:
   5,000 signatures a month, which for a release-per-week project is thousands more than we need.
4. Assign yourself the **Artifact Signing Identity Verifier** role, or the "New identity" button
   stays greyed out.
5. **Identity validation → Individual → Public.** The form fills itself from the billing account.
   Then comes the Verified-ID flow: an email PIN, a phone number, a QR code, a government ID
   photographed with your phone, and Microsoft Authenticator. Have a passport or driver's licence to
   hand, and expect it to be fiddlier on a phone than it sounds.
6. **Create a certificate profile** of type **Public Trust**. This is what actually signs.

**Processing takes 1 to 20 business days.** That is Microsoft's own figure, and it is why this
document exists rather than a paragraph in a chat message.

### What that turns into (wired 2026-09-23)

**No secret.** An Entra app registration with a **federated credential** that trusts GitHub's OIDC
token for this repository's `deploy` environment: the release job asks GitHub for a token
(`permissions: id-token: write`), `azure/login` hands it to Azure, and the Azure CLI on the runner is
signed in for the rest of the job. Nothing is pasted, nothing expires, nothing can leak from a log.
The app registration needs the **Artifact Signing Certificate Profile Signer** role on the account.
One wrinkle worth knowing: a GitHub OIDC token lives **five minutes**, and the Azure CLI redeems it
per resource, so a login before a half-hour build is stale by the time `signtool` asks for Artifact
Signing. The sign script therefore mints a fresh ID token and logs in again right before each
signature; the workflow's early `azure/login` is just the fast check that federation works.

Six **environment variables** (not secrets — none is confidential) in the `deploy` environment:

```
AZURE_CLIENT_ID          the app registration's client id (a GUID)
AZURE_TENANT_ID          the Entra tenant (a GUID)
AZURE_SUBSCRIPTION_ID    the subscription the signing account lives in (a GUID)
AZURE_SIGNING_ENDPOINT   https://<region>.codesigning.azure.net - the region's URI, e.g. wus2, eus, cus
AZURE_SIGNING_ACCOUNT    the Artifact Signing account's name
AZURE_SIGNING_PROFILE    the Public Trust certificate profile's name
```

Set with `gh variable set NAME --env deploy --body VALUE`. The preflight job checks their shapes and
insists on all six or none; the endpoint's region must match where the account AND profile were
created, or signing fails with a 403 that says nothing about regions.

How signing actually happens: Microsoft's `signtool` with the Artifact Signing dlib
(`desktop/tools/sign-windows.ps1`, called per file as `bundle.windows.signCommand` - configured by
the workflow's tools step and merged into the build with `--config`, since the bundler needs the
script's absolute path and a local build should stay unsigned). The dlib authenticates through the CLI session above. The
certificate Microsoft issues is valid for **three days** — every signature is timestamped against
`timestamp.acs.microsoft.com`, which is what keeps it valid after that. The community
`artifact-signing-cli` the Tauri docs mention was not used: it authenticates by client secret only.

---

### ...and it signs the server node too (2026-09-25)

The same key signs every `ringtome-server-…tar.gz` (the `server-sign` job, the one server job in the
`deploy` environment), and `server-latest.json` carries those signatures for the server's own updater
- `ringtome-supervisor` (`supervisor/src/manifest.rs`, `verify`; the public half is compiled into
`supervisor/src/config.rs`). One key, one public half, two kinds of update. The job
verifies every signature with the stock `minisign` tool against the public key committed in
`desktop/tauri.conf.json` before it uploads anything.

The container image is signed differently, with no key at all: **cosign keyless** (Sigstore) turns
the workflow's GitHub OIDC token into a short-lived certificate saying "cube-drone/ringtome's release
workflow, at this tag", and signs the image's digest with it. Nothing to store, rotate or lose.
SERVER.md has the verification commands for both.

## 3. Where the secrets go

The `deploy` GitHub environment (Settings → Environments). The release workflow reads exactly these
names; nothing else needs to know them. Secrets (`gh secret set NAME --env deploy < file`):

```
APPLE_CERTIFICATE              APPLE_CERTIFICATE_PASSWORD     APPLE_SIGNING_IDENTITY
APPLE_API_ISSUER               APPLE_API_KEY                  APPLE_API_KEY_BASE64
TAURI_SIGNING_PRIVATE_KEY      TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Variables (`gh variable set NAME --env deploy --body VALUE`) — Windows signs by OIDC, so its six are
plain facts, listed in §2:

```
AZURE_CLIENT_ID                AZURE_TENANT_ID                AZURE_SUBSCRIPTION_ID
AZURE_SIGNING_ENDPOINT         AZURE_SIGNING_ACCOUNT          AZURE_SIGNING_PROFILE
```

Rules that are boring until the day they are not: no secret goes in the repo, in
`tauri.conf.json`, in an issue, or in a chat window. The updater's **public** key is the one thing in
this list that is meant to be committed. A secret that has been pasted anywhere else is burned —
rotate it, which for everything here except the updater key is merely annoying.

---

## 4. The order, and what happens while you wait

1. **Today:** generate the updater key (§0), and start the Apple enrolment (§1) — it is the long pole
   and the only one whose absence stops Mac users entirely.
2. **Today or tomorrow:** start the Azure identity validation (§2). It runs in the background for up
   to four weeks; there is nothing to do but wait once it is submitted.
3. **Meanwhile,** the unsigned build continues: bundle configuration, icons, a real `.dmg` we can
   launch, the CI matrix producing artifacts for all four targets, and the updater end-to-end against
   your own key. None of it is rework — signing is environment variables bolted onto a pipeline that
   already exists.
4. **When Apple lands:** Mac releases become signed and notarized, and the friends-and-family round
   can start on Macs whatever Windows is doing.
5. **When Azure lands:** Windows installers get signed, and SmartScreen begins accruing reputation.
   Expect warnings for the first while regardless; that is the OV bargain, not a mistake.

## 5. What to do about round one before any of it arrives

An unsigned `.dmg` can be opened — right-click → Open, then "Open" again in the dialog — and an
unsigned `.exe` runs through "More info" → "Run anyway". For six people who know you and got the link
from you, that is an acceptable first round, and it gets the app into hands weeks earlier than the
paperwork allows. For anybody else it is not, which is the whole reason for the $99.
