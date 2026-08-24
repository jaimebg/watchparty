import type { MediaInfo } from './probe.js'

// ffmpeg's mode, the planner's grid and the HLS variant count are ONE SINGLE
// contract, and breaking it does not produce an error: it produces a playlist
// that lies. The playlist is VOD (complete from the first moment), so the server
// has to know IN ADVANCE where ffmpeg is going to cut. And guessing does not work:
//
// Measured on a real 2:36 WEBRip in copy mode:
//   - the planner's rule ("first keyframe >= 4 s after the previous cut"): 1295 cuts
//   - what ffmpeg actually did:                                            2212 cuts
// The HLS muxer does not cut "4 s after the previous cut" but against an
// absolute grid that advances 4 s per segment even when the previous segment
// overshot: that is why it produces a 1.4 s segment right after a 12 s one.
// Simulating that rule reproduces the 2212 cuts exactly; the planner's does not.
//
// The consequence was exactly the reported bug: the playlist listed 1295
// segments, and those 1295 files only cover up to minute 1:26:58 of the movie.
// The room ran out of video right there. And even copying the muxer's rule, it
// still could not be correct: after a seek ffmpeg restarts that absolute grid at
// the -ss point, so the cuts following any restart no longer line up with those
// planned from 0.
//
// On top of that, audio has no keyframes: EVERY sample is a valid cut point, so
// the muxer splits an audio-only variant at exactly every -hls_time, ignoring
// where the video was split. On the same movie the video came out in 2212
// segments and the audio in 2346, both covering the same 9382 s; since the
// server serves the same playlist for both variants, the audio ended up declared
// as much as 551 s beyond what existed.
//
// The only way for the playlist to be correct BY CONSTRUCTION is not to let
// ffmpeg choose: transcode while forcing keyframes every 4 s (see ffmpegArgs.ts).
// With the source cut on a uniform grid, any muxer rule lands on the same
// boundaries, including after a mid-file restart and including for audio.
// Measured on the same file: planner<->ffmpeg deviation of 0.0000 s in transcode
// mode against 7.8 s in copy, and h264_videotoolbox produces at ~8x real time,
// plenty for watching live.

export function pickMode(_info: MediaInfo, _forceTranscode = false): 'copy' | 'transcode' {
  return 'transcode'
}

/**
 * How many HLS variants ffmpeg produces (and hence which `seg_V_*`/`init_V.mp4`
 * exist). With 0 or 1 track it is a single one, with the audio muxed inside;
 * with several, 0 is the video and 1..N are one per track.
 */
export function variantCount(audioCount: number): number {
  return audioCount <= 1 ? 1 : audioCount + 1
}
