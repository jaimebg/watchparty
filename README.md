# Watchparty

A self-hosted, cross-platform server for watching movies and shows together in sync. The host runs the server on their own machine; guests join from their browsers over the internet through an integrated tunnel. Includes real-time chat with floating reactions and GIF search.

**Features:**
- 🎬 Real-time playback synchronization (pause, play, seek)
- ⏳ The room waits for the viewer who is still buffering (capped at 20 s, so a bad connection doesn't stall the session)
- 🎙️ Independent audio and subtitle track selection per viewer
- 💬 Live chat with floating reactions and GIF search
- 🔗 Automatic remote access via a secure HTTPS tunnel (cloudflared)
- 🖥️ Cross-platform support (Windows and macOS)
- 🎯 Small groups (3–6 people)

## Requirements

- **Node.js** ≥ 20
- **npm** or equivalent
- Windows or macOS (prebuilt ffmpeg and cloudflared binaries are included)

## Installation

### Step 1: Clone and install dependencies

```bash
npm install
```

### Step 2: Configure media folders

The first time you open the library, a **«📁 Choose folder…»** button opens your
system's native dialog (Finder/File Explorer) so you can pick your videos folder. No
file editing required. If you prefer, you can also type the path by hand in the
same setup wizard, or edit the configuration directly.

Configuration is read in two layers, from lowest to highest priority:

1. **`config.defaults.json`** (repo root, versioned). A template with generic
   defaults only. Every optional field ships as `null`.
2. **`config.json`** (local, outside the repo). Everything specific to your
   machine: media folders and any API keys or tunnel settings. It lives in the
   data directory of your platform:
   - **macOS:** `~/Library/Application Support/jbg-watchparty/config.json`
   - **Windows:** `%APPDATA%\jbg-watchparty\config.json`
   - **Linux:** `~/.local/share/jbg-watchparty/config.json`

A value in the local `config.json` overrides the shared file, unless it is
`null`: `null` means "not configured". On first run, the app creates the local
config for you; you can also create it by hand.

Example (all fields are optional except where noted):

```json
{
  "mediaFolders": [
    "/Users/youruser/Videos/Movies",
    "/Users/youruser/Videos/Series"
  ],
  "klipyApiKey": "your-optional-klipy-api-key",
  "tmdbApiKey": "your-optional-tmdb-api-key",
  "port": 8400,
  "cacheLimitGB": 10
}
```

**Configuration fields:**
- **`mediaFolders`** (array of strings): Absolute paths to folders containing videos (MKV, MP4, AVI, etc.). Required; you can also add the first folder from the host panel if you start with an empty library. Machine-specific: put it in the local `config.json`, never in `config.defaults.json`.
- **`klipyApiKey`** (string, optional): Klipy API key to search and send GIFs in chat. If absent, the GIF button is hidden.
- **`tunnelToken`** (string, optional): Token of a Cloudflare named tunnel. With it (along with `tunnelUrl`), the server uses your tunnel with a fixed URL instead of the random Quick Tunnel. See [Fixed URL with your own domain](#fixed-url-with-your-own-domain-named-tunnel).
- **`tunnelUrl`** (string, optional): Fixed public URL of the tunnel, e.g. `https://watchparty.yourdomain.com`. Required if you use `tunnelToken` (they must be configured together).
- **`streamBaseUrl`** (string, optional): Origin from which clients fetch video, e.g. `https://stream.yourdomain.com`. Without it (the default), video is served from the same origin as the app. See [Serving video off the CDN](#serving-video-off-the-cdn-separate-data-plane).
- **`relayPeerPublicKey`**, **`relayEndpoint`**, **`relayPeerIp`**, **`relayLocalIp`** (strings, optional): Details of your relay VPS, so `npm run setup` can bring up the WireGuard tunnel on a new machine without anyone having to remember anything. They describe the VPS rather than the machine, and none is secret (a public key and an endpoint), so multi-machine owners may keep them in `config.defaults.json`; everyone else should keep them in the local `config.json`. `relayLocalIp` is fixed on purpose: the reverse_proxy on the VPS points at a single address, so only one host can use it at a time.
- **`tmdbApiKey`** (string, optional): TMDB API key (themoviedb.org → Settings → API). With it, creating a room looks up metadata from the file name: the room title becomes "Title (year)" and an **ℹ️ Info** button appears with poster, rating and synopsis. Episodes (`S01E02` in the name) are looked up as series. Without a key, everything works the same but with the bare file name.
- **`port`** (number): HTTP port of the server (default: 8400).
- **`cacheLimitGB`** (number): HLS cache limit in GB (default: 10). Cleaned up automatically when rooms close.

### Step 3: Run the server

```bash
npm start
```

`npm start` begins with an **environment check** that runs on both macOS and Windows:
it fixes on its own whatever can be fixed automatically (bringing up the relay tunnel if
configured) and warns about the rest with the concrete action next to it. It aborts only
when starting would make no sense: Node below 20, no ffmpeg, or the port already taken by
another instance. Warnings (empty library, folder that no longer exists, tunnel down) do
not block anything, because the panel and the local network keep working.

```
🎬 Watchparty environment check

✅ Node 22
✅ ffmpeg and ffprobe bundled
✅ Web UI built
✅ 1 media folder(s)
✅ Port 8400 free
✅ Relay active toward https://stream.example.com

▶️  All set.
```

You can run just the check with `npm run preflight`. Afterwards, the server:
1. Scans the configured media folders
2. Automatically brings up a secure HTTPS tunnel (cloudflared Quick Tunnel)
3. Opens your browser at `http://localhost:8400/?key=<admin-token>`. The `key` is a token generated at startup that authenticates the host panel (stored in a cookie after the first visit)
4. Shows the secure public URL to share with guests

**All commands:**

| Command | Purpose |
|---|---|
| `npm start` | Checks the environment, builds the web client and starts the server |
| `npm run setup` | Set up a brand-new machine (generates the relay tunnel) |
| `npm run preflight` | Only the environment check, without starting anything |
| `npm run tunnel:up` / `tunnel:down` | Manual control of the relay tunnel |
| `npm test` | The whole test suite |

### Step 4: Share the link

Copy the public URL shown in the console or in the web interface. Guests join like this:
1. Click the HTTPS link
2. Enter their name
3. See the live room (without creating a new one)

## Rooms and movies

A room and a movie are different things:

- **Creating an empty room** gives you a shareable link instantly, before choosing
  anything. Guests join, type their name and can **chat** while the host decides;
  they see a waiting card where the video would be.
- **Only the host** (whoever holds the admin cookie, i.e. whoever opened the
  panel on `localhost`) can set or change the movie, with the
  «🎬 Choose/Change movie» button in the room header. Play, pause and the seek bar
  belong to everyone.
- **Changing movies** neither closes the room nor changes the link. The new file is
  probed again, so duration, audio tracks, available subtitles and TMDB metadata are
  **recomputed**; playback starts paused at 0:00 and the **chat is preserved**.
  Nobody needs to reload.

Each movie in a room is a numbered "generation", and that number goes into the video
URL: `/stream/<token>/e2/master.m3u8`. It isn't decorative. Segments and init are named
identically across movies (`init_0.mp4`, `seg_0_00000.m4s`), so without versioning the
URL the browser cache (or the relay cache, if you use `streamBaseUrl`) would serve the
previous movie's bytes. It goes in the path rather than a query string so versioning
doesn't depend on how the relay proxy treats queries, and so the relative URIs inside
playlists land within the right generation by themselves.

## Fixed URL with your own domain (named tunnel)

By default the server uses a cloudflared Quick Tunnel: the URL (`*.trycloudflare.com`)
changes on every start. If you have a domain managed in Cloudflare, you can get a fixed
URL (e.g. `https://watchparty.yourdomain.com`) with a one-time setup:

1. Sign in at [one.dash.cloudflare.com](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel** (Cloudflared type) and give it a name (e.g. `watchparty`).
2. At the connector step, **don't install anything**: just copy the token shown in the command (`cloudflared service install <TOKEN>`; the token is the long string).
3. Under **Public Hostnames**, add `watchparty.yourdomain.com` → service `http://localhost:8400` (the port from your `config.json`). Cloudflare creates the DNS route automatically.
4. In your local `config.json`, add:

```json
{
  "tunnelToken": "eyJh...your-token...",
  "tunnelUrl": "https://watchparty.yourdomain.com"
}
```

On startup, the server brings up your tunnel with that fixed URL (the same one on every
restart). If either field is missing, it warns on the console and falls back to the Quick
Tunnel. The app uses its own cloudflared binary; there's nothing to install system-wide.

## Serving video off the CDN (separate data plane)

The Cloudflare CDN terms for Free/Pro/Business plans reserve the right to limit service
for anyone using it "to serve video or a disproportionate percentage of pictures, audio
files, or other large files", with an exemption only if the content is hosted on a
Cloudflare service (Stream, Images, R2). The public hostname of a tunnel is a CNAME to
`<uuid>.cfargotunnel.com`, which **only resolves through the proxy**: you can't grey-route
it, so all video goes through the CDN by construction. A 6-person, 2-hour session moves
roughly 30 GB.

`streamBaseUrl` separates the two planes:

| Plane | What it carries | How it travels |
|---|---|---|
| Control | HTML, API, WebSocket (chat, sync, presence) | Cloudflare tunnel (intended use, negligible traffic) |
| Data | `master.m3u8`, `init_*.mp4`, `seg_*.m4s`, `sub_*.vtt` | Your relay, bypassing the CDN |

Pointing the `master.m3u8` at the relay is enough: HLS resolves the playlist's relative
names against the playlist URL, so init and segments follow along by themselves.

### Setting up the relay on a VPS (Oracle Cloud example)

Oracle is a good fit: 10 TB/month of egress on Always Free, and its acceptable use policy
has no content-type clause equivalent to Cloudflare's CDN one.

1. **Instance and network.** Create the VM and open 443 in the VCN *Security List* (ingress
   0.0.0.0/0 → TCP 443). **Watch out for the step everyone skips:** Oracle images ship
   persistent restrictive `iptables`, so opening the VCN isn't enough:
   ```bash
   sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save     # Ubuntu; on Oracle Linux: firewall-cmd --add-port=443/tcp --permanent
   ```
2. **DNS.** `A` record from `stream.yourdomain.com` to the VPS public IP, **grey-routed
   (DNS-only)**. That's what keeps traffic out of the CDN; the free authoritative DNS has
   no content restriction because it carries no bytes.
3. **Home → VPS tunnel.** WireGuard between the two machines (the VPS as the fixed
   *endpoint*). The home host needs neither a public IP nor port forwarding, and works
   behind CGNAT.
4. **TLS and proxy on the VPS.** With Caddy, the entire `Caddyfile` is:
   ```
   stream.yourdomain.com {
       reverse_proxy 10.0.0.2:8400   # the WireGuard IP of the home host
   }
   ```
   Caddy obtains and renews the Let's Encrypt certificate by itself.
5. **Host config.** In the local `config.json`:
   ```json
   { "streamBaseUrl": "https://stream.yourdomain.com" }
   ```

**Idle reclaim:** Oracle may reclaim Always Free instances that stay below the 95th
percentile of 20% CPU **and** 20% network (and 20% memory on A1 shapes) for 7 days. A
relay used two hours a week fits that profile exactly. Options: move the instance to paid
(cents per month), keep it busy, or accept recreating it occasionally and script the steps
above. Paid instances are unaffected.

Without `streamBaseUrl` everything stays exactly as before (same origin), which is the
right behavior on a LAN.

### Setting up the home end on another machine (macOS or Windows)

With the `relay*` fields in place, a new machine gets ready with a single command.
Install WireGuard first (`brew install wireguard-tools` on macOS,
[the official installer](https://www.wireguard.com/install/) on Windows), then:

```bash
npm run setup
```

It generates that machine's key pair, writes its `wg0.conf` where the platform expects
it, and prints the only remaining command to run on the VPS, with the public key already
substituted. It's idempotent: if the tunnel is already configured it regenerates nothing,
because doing so would invalidate the key the VPS has authorized.

From then on, `npm start` brings the tunnel up by itself. Details of how:

- **It only asks for elevation if the tunnel isn't already up** (administrator password on
  macOS, UAC on Windows). Starting the server twice the same afternoon doesn't ask again.
- **It doesn't tear it down when done.** An idle tunnel costs a packet every 25 s, and
  tearing it down would force a second authentication per session. To take it down:
  `npm run tunnel:down`.
- **It checks that the far end actually responds**, not just that the interface exists: a
  down VPS leaves an interface up that looks healthy but serves no video.

Elevation is requested through the OS dialog and **not** through a `NOPASSWD` sudoers rule
on purpose: on macOS the Homebrew prefix is user-writable, so giving passwordless sudo to
a binary that same user could replace would be a root escalation for any process running
as them.

## Getting a Klipy API key (optional)

For GIF search in chat:

1. Go to [https://klipy.com/developers](https://klipy.com/developers)
2. Create an account and sign in
3. Generate a new API key
4. Copy the key into the `klipyApiKey` field of your local `config.json`

Without an API key, chat works perfectly fine; only the GIF button is unavailable.

## Supported formats

**Video:**
- MKV (Matroska): multiple audio and subtitle tracks
- MP4 (H.264)
- AVI
- WebM

**Video codecs:**
- Everything is transcoded to H.264 with keyframes forced every 4 s (hardware
  acceleration when available: VideoToolbox on macOS, NVENC/QSV on Windows).

  Stream-copying the video would be cheaper, but the playlist is VOD: the server must
  declare *in advance* where each segment will be cut. In copy mode the cuts are
  chosen by ffmpeg's HLS muxer against its own grid, which the server cannot predict.
  When the two lists disagree, the playlist ends up short and the room freezes mid-movie.
  The full reasoning, with measurements, lives in
  `server/src/media/hlsLayout.ts`.

  Additionally, the server pins the media timeline instead of inheriting it from ffmpeg:
  it serves a canonical init (stripped of the edit-list entries that depend on the
  particular process ffmpeg happened to start from; the rest, such as codec delay trim,
  is preserved) and anchors each segment header to the instant the playlist already
  declares. Without this, a seek only landed correctly while the room kept running on the
  same ffmpeg that produced the first init. The MP4 box editing lives in
  `server/src/media/fmp4.ts`.

**Audio tracks:**
- With a single track, audio travels inside the video segment itself.
- With several, each one is exposed as an independently selectable AAC rendition per
  viewer.

**Subtitles:**
- Embedded text tracks (SRT, ASS/SSA)
- External `.srt` files next to the video (detected automatically)
- Converted to WebVTT for browser playback
- Image-based tracks (PGS/VobSub) are silently skipped: they don't appear in the room's subtitle selector

## Chat features

### Text messages
- Each user gets a color assigned on join
- Real-time bidirectional messages

### Reactions
- Quick emoji bar, customizable per viewer
- The «+» button opens a picker with the full catalog and a search field
- Your selection persists in the browser (up to 12 emojis)
- Emojis float upward over the video on both screens (Instagram Live style)
- The emoji also appears, small and for a few seconds, next to the sender's name in the participant list
- They don't appear in the chat history

### GIFs
- Search integrated against the Klipy API (if configured)
- The chosen result is embedded as a chat message
- Only visible if the API key is present in `config.json`

### System messages
- Notifications when someone joins, leaves, pauses, resumes or changes the video

## Fullscreen
- Button in the controls, double-click on the video or the `F` key
- Chat and reactions float at the bottom right over the video
- Everything hides after a few seconds without activity and comes back on mouse move,
  keypress or a new message; with the chat focused or the room paused, it never hides
- On iPhone, where the browser disallows fullscreen with overlays, a "cinema mode" that
  fills the window is used instead

## Development

### Running in development mode

Open two terminals:

**Terminal 1: Server (no auto-reload)**
```bash
npm start -w server
```
`tsx` runs the server straight from TypeScript, but without `--watch`: after every change
in `server/src`, stop the process (`Ctrl+C`) and launch `npm start -w server` again.

**Terminal 2: Client (with Vite dev server)**
```bash
npm run dev -w web
```

Open `http://localhost:5173/` for the development client.

### Running tests

```bash
npm test
```

Runs unit and integration tests for both packages (server and web).

### Type checking

```bash
npx tsc --noEmit
```

In server/: verifies the server's TypeScript types.

```bash
cd web && npx tsc --noEmit
```

In web/: verifies the client's TypeScript types.

### Regenerating the emoji catalog

```bash
node web/scripts/gen-emoji-catalog.mjs
```

Rewrites `web/src/chat/emojiCatalog.ts` from emojibase-data. Only needed when Unicode
ships new emojis. Requires network access, which is why it stays out of the build and the
tests.

### Production build

```bash
npm run build -w web
```

Builds the React client for production into `web/dist/`.

## Limitations in v1

- **Image-based subtitles** (PGS/VobSub): unsupported; silently skipped (they don't appear as options in the selector)
- **Persistence**: chat and room history are lost when the room closes
- **User accounts**: no authentication; only basic host/guest roles
- **Native packaging**: v1 requires Node.js and `npm start`; Electron/installer left for future versions

## Project structure

```
.
├── server/                   # Fastify + Node.js
│   ├── src/
│   │   ├── index.ts          # Entry point
│   │   ├── app.ts            # Fastify app construction (routes + static files)
│   │   ├── config.ts         # config.json loading/saving
│   │   ├── http/             # REST routes (library, rooms, stream, klipy, admin)
│   │   ├── library/          # Media folder scanning
│   │   ├── media/            # Probe, segment planning, ffmpeg, MP4 boxes, subtitles, cache
│   │   ├── rooms/            # Room state and playback synchronization
│   │   ├── ws/               # WebSocket (sync, chat, reactions, presence)
│   │   └── tunnel/           # cloudflared integration
│   └── package.json
├── web/                      # React + Vite + hls.js
│   ├── src/
│   │   ├── App.tsx           # Root component (simple pathname routing)
│   │   ├── api.ts, ws.ts, types.ts
│   │   ├── pages/            # Library, room
│   │   ├── player/           # HLS player and drift correction
│   │   ├── chat/             # Chat, reactions, GIFs
│   │   └── sync/             # Drift correction math
│   └── package.json
├── package.json              # Root workspace
└── README.md                 # This file
```

## Troubleshooting

### The server won't start
- Verify Node.js ≥ 20 is installed: `node --version`
- Check that `config.json` exists and has at least one valid `mediaFolder`
- Check nothing else is listening on the configured port (default 8400)

### Guests can't connect
- The public URL requires internet; use mobile data to verify from another device
- If the tunnel drops, the server relaunches it automatically; with a Quick Tunnel the URL changes and the link must be re-shared (a named tunnel keeps its fixed URL)
- Check the browser is up to date (recent Chrome, Safari, Firefox)

### Video won't play
- Verify the file is inside a folder listed in `mediaFolders`
- If it's HEVC/x265, ffmpeg is transcoding; this can take minutes on old hardware
- On error, the room shows the ffmpeg log with a «Retry» button
- If after a seek the position stalls and "X is buffering…" appears, that's expected: the room waits up to 20 s for the straggler
- Seeking mid-MKV used to leave subtitles over a black frame; that sync bug was fixed. If you ever see it again, please report it; it's not a known limitation

### Audio doesn't change for some viewers
- That's expected: each user picks their track independently
- Only playback position is synchronized globally

## License

[MIT](LICENSE)
