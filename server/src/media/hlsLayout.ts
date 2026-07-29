import type { MediaInfo } from './probe.js'

// El modo de ffmpeg, la rejilla del planner y el número de variantes HLS son UN
// SOLO contrato, y romperlo no da un error: da una playlist que miente. La
// playlist es VOD (completa desde el primer momento), así que el servidor tiene
// que saber DE ANTEMANO dónde va a cortar ffmpeg. Y adivinarlo no funciona:
//
// Medido sobre un WEBRip real de 2:36 en modo copy:
//   - regla del planner («primer keyframe a >= 4 s del corte anterior»): 1295 cortes
//   - lo que ffmpeg hizo de verdad:                                     2212 cortes
// El muxer HLS no corta «4 s después del corte anterior», sino contra una
// rejilla absoluta que avanza 4 s por segmento aunque el segmento anterior se
// haya pasado: por eso produce segmentos de 1,4 s justo después de uno de 12 s.
// Simular esa regla reproduce los 2212 cortes exactos; la del planner, no.
//
// La consecuencia fue exactamente el fallo reportado: la playlist listaba 1295
// segmentos, y esos 1295 archivos solo cubren hasta el minuto 1:26:58 de
// película. La sala se quedó sin vídeo justo ahí. Y aunque se copiara la regla
// del muxer, seguiría sin poder ser correcta: tras un seek ffmpeg reinicia esa
// rejilla absoluta en el punto del -ss, así que los cortes posteriores a
// cualquier reinicio ya no coinciden con los planificados desde 0.
//
// A eso se suma que el audio no tiene keyframes: TODA muestra vale como punto
// de corte, así que a una variante de solo-audio el muxer la parte cada
// -hls_time exacto, ignorando dónde partió el vídeo. En la misma película el
// vídeo salió en 2212 segmentos y el audio en 2346, cubriendo ambos los mismos
// 9382 s; como el servidor sirve la misma playlist para las dos variantes, el
// audio acababa declarado hasta 551 s por delante del que existía.
//
// La única forma de que la playlist sea correcta POR CONSTRUCCIÓN es no dejar
// que ffmpeg elija: transcodificar forzando keyframes cada 4 s (ver
// ffmpegArgs.ts). Con la fuente cortada en una rejilla uniforme, cualquier
// regla del muxer cae en los mismos límites, también tras un reinicio a mitad y
// también para el audio. Medido en el mismo archivo: desviación planner<->ffmpeg
// de 0,0000 s en modo transcode frente a 7,8 s en copy, y h264_videotoolbox
// produce a ~8x tiempo real, de sobra para ver en directo.

export function pickMode(_info: MediaInfo, _forceTranscode = false): 'copy' | 'transcode' {
  return 'transcode'
}

/**
 * Cuántas variantes HLS produce ffmpeg (y por tanto qué `seg_V_*`/`init_V.mp4`
 * existen). Con 0 o 1 pista es una sola, con el audio muxeado dentro; con
 * varias, la 0 es el vídeo y la 1..N son una por pista.
 */
export function variantCount(audioCount: number): number {
  return audioCount <= 1 ? 1 : audioCount + 1
}
