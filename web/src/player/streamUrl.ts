// The data plane (playlists, init, segments, VTT) can live on an origin other
// than the app's: see `streamBaseUrl` in server/src/config.ts for why. All that
// happens here is composing the URL.
//
// The `epoch` versions the room's movie generation. It goes in the PATH and not
// in a query for two reasons: a playlist's relative names resolve against that
// playlist's URL, so init_*.mp4 and seg_*.m4s land inside e<n>/ on their own and
// planner.ts never needs to know the epoch exists; and versioning then does not
// depend on the relay proxy forwarding the query, nor on how it computes its
// cache key.
//
// Applying it to master.m3u8 and the VTTs is enough: the rest of the playlist
// follows the master's host and epoch. The <track>s, on the other hand, are built
// by the app and not the playlist, so those do come through here.
export function streamUrl(base: string | null | undefined, token: string, epoch: number, file: string): string {
  // The trailing slash is trimmed so we never emit `https://host//stream/...`: a
  // double slash survives URL normalization and breaks the prefix the playlist's
  // relative names resolve against.
  const root = (base ?? '').replace(/\/+$/, '')
  return `${root}/stream/${token}/e${epoch}/${file}`
}
