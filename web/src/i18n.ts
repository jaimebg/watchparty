// Lightweight i18n: two hand-written catalogues (no library, no runtime locale
// negotiation beyond the browser's own preference list). Spanish wording comes
// from the revision before the UI was translated to English (0543318 and
// 713f2c6 in the history), so it is the phrasing already reviewed back then.

export type Lang = 'en' | 'es'
type Vars = Record<string, string | number>

// First preference matching a supported language wins, so ["en", "es"] stays
// English. With nothing supported at all, any Spanish later in the list still
// tilts it Spanish ("user has any Spanish UI"); otherwise English.
export function detectLang(prefs?: readonly string[] | string): Lang {
  const list = typeof prefs === 'string' ? [prefs] : prefs ?? []
  for (const pref of list) {
    const base = pref.toLowerCase().split(/[-_]/)[0]
    if (base === 'es') return 'es'
    if (base === 'en') return 'en'
  }
  return 'en'
}

// ?lang=es|en forces the UI language (manual hook for testing and for hosts who
// share the room link with one fixed language).
export function langFromSearch(search: string): Lang | null {
  const v = new URLSearchParams(search).get('lang')
  return v === 'es' || v === 'en' ? v : null
}

const en = {
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.copied': 'Copied!',
  'common.copyLink': 'Copy link',
  'common.join': 'Join',
  'common.remove': 'Remove',
  'common.retry': 'Retry',

  'movie.change': 'Change movie',
  'movie.pick': 'Pick movie',

  'library.privateScreening': 'Private screening',
  'library.gateA': 'To watch the session you need the ',
  'library.gateRoomLink': 'room link',
  'library.gateB': ' the host shares. It ends in ',
  'library.gateC': '. Ask them for it and open it as is.',
  'library.roomCode': 'Room code or link',
  'library.badRoomCode': "That doesn't look like a room code. Paste the full link or the code after /room/.",
  'library.hostHintA': 'Are you the host? Enter through the ',
  'library.hostHintB': ' URL printed by the terminal when the server starts (it opens in your browser on its own).',
  'library.loadError': "Couldn't load the library. ({error})",
  'library.loading': 'Warming up the projector…',
  'library.settingUpFor': 'Setting up the room for “{title}”',
  'library.settingUp': 'Setting up the room…',
  'library.settingUpHint': 'We probe the video and prepare the subtitles: with long movies this can take a few seconds.',
  'library.linkCopiedHint': "The link is copied to your clipboard as soon as it's ready.",
  'library.createEmptyRoom': '🎬 Create empty room',
  'library.addFolderBusy': '📁 Add folder…',
  'library.waiting': 'Waiting…',
  'library.folderDialogHint': "Your system's dialog opens (check Finder/File Explorer if you don't see it).",
  'library.typePath': 'Or type the path by hand',
  'library.folderPathPlaceholder': '/absolute/path/to/your/videos',
  'library.folderPathLabel': 'Media folder path',
  'library.adding': 'Adding…',
  'library.addFolder': 'Add folder',
  'library.marquee': 'The marquee',
  'library.emptyNoFolders': 'Nothing on the marquee yet: no media folders configured.',
  'library.emptyNoVideos': 'The configured folders contain no videos (MKV, MP4, AVI, M4V, WebM).',
  'library.addFirstFolder': 'Add your first media folder',
  'library.mediaFolders': 'Media folders',
  'library.mediaFoldersCount': '⚙️ Media folders ({count})',
  'library.shareNow': 'Share the link now and pick the movie inside the room.',
  'library.settingUpShort': 'Setting up…',
  'library.createRoom': 'Create room →',

  'room.notFound': 'Room not found',
  'room.notFoundHint': 'The link may have expired. Ask the host for a new one.',
  'room.ticketTo': 'Your ticket to',
  'room.theShow': 'the show',
  'room.yourName': 'Your name',
  'room.prepareError': "Couldn't prepare the room",
  'room.tunnelDown': 'Tunnel down, relaunching…',
  'room.noMovie': 'Room without a movie',
  'room.copyLinkTitle': "Copy the room's public link ({url})",
  'room.movieInfo': 'Movie info',
  'room.changeMovieTitle': "Change the room's movie",
  'room.pickMovieTitle': "Pick the room's movie",
  'room.copyFailed': "Couldn't copy automatically. Copy it by hand:",
  'room.publicLinkLabel': 'Room public link',
  'room.noMovieYet': 'No movie yet',
  'room.pickWhatYouWatch': "Pick what you'll watch",
  'room.hostPicking': 'The host is picking the movie',
  'room.hostWaitingHint': 'Meanwhile you can copy the link and pass it around: the room already exists.',
  'room.guestWaitingHint': 'You can start chatting; the video will show up on its own.',

  'chat.away': 'away',
  'chat.buffering': '{name} is buffering…',
  'chat.placeholder': 'Type a message…',
  'chat.messageLabel': 'Chat message',
  'chat.send': 'Send',
  'chat.joined': '{name} joined',
  'chat.left': '{name} left',
  'chat.resumed': '{name} resumed',
  'chat.paused': '{name} paused',
  'chat.seek': '{name} jumped to {time}',
  'chat.nowPlaying': 'now playing “{title}”',
  'chat.setBy': '{name} put on “{title}”',

  'player.noHls': "This browser can't play HLS. Try a recent version of Chrome, Firefox or Safari.",
  'player.play': 'Play (space)',
  'player.pause': 'Pause (space)',
  'player.mute': 'Mute',
  'player.unmute': 'Unmute',
  'player.volume': 'Volume',
  'player.volumePercent': 'Volume {percent}%',
  'player.position': 'Position in movie',
  'player.positionOf': '{position} of {duration}',
  'player.totalDuration': 'Total duration {duration}',
  'player.audioTrack': 'Audio track',
  'player.subtitles': 'Subtitles',
  'player.noSubtitles': 'No subtitles',
  'player.fullscreen': 'Fullscreen (F)',
  'player.exitFullscreen': 'Exit fullscreen (F)',

  'meta.noSynopsis': 'No synopsis available.',
  'meta.dataFromTmdb': 'Data from TMDB',

  'picker.nowPlaying': ' · now playing',
  'picker.externalOne': '1 external subtitle',
  'picker.externalMany': '{count} external subtitles',
  'picker.noExternalSubs': 'no external subtitles',
  'picker.applyingTitle': '“{title}”',
  'picker.gettingReady': 'Getting it ready for the whole room: we analyze the video and extract the subtitles. It can take a few seconds.',
  'picker.searchPlaceholder': 'Search by title…',
  'picker.searchLabel': 'Search movies',
  'picker.confirmA': "You're about to change the movie ",
  'picker.confirmForEveryone': 'for everyone',
  'picker.confirmB': '. Playback starts over and the chat is kept.',
  'picker.playIt': 'Play it',
  'picker.loadingLibrary': 'Loading the library…',
  'picker.noVideos': 'No videos in the configured folders.',
  'picker.noTitlesMatch': 'No titles match.',
  'picker.scanning': 'Scanning…',
  'picker.rescan': '↻ Rescan',

  'emoji.quickPicks': 'Your quick picks',
  'emoji.pickEmojis': 'Pick emojis',
  'emoji.noneYet': 'None yet: pick the ones you want below.',
  'emoji.remove': 'Remove {emoji}',
  'emoji.max': 'Max {max}: remove one to add another.',
  'emoji.searchPlaceholder': 'Search emoji…',
  'emoji.searchLabel': 'Search emoji',
  'emoji.loading': 'Loading emojis…',
  'emoji.noMatch': 'No emoji matches.',
  'emoji.group.0': 'Smileys',
  'emoji.group.1': 'People',
  'emoji.group.3': 'Animals',
  'emoji.group.4': 'Food',
  'emoji.group.5': 'Travel',
  'emoji.group.6': 'Activities',
  'emoji.group.7': 'Objects',
  'emoji.group.8': 'Symbols',
  'emoji.group.9': 'Flags',

  'gif.searchPlaceholder': 'Search GIFs…',
  'gif.searchLabel': 'Search GIFs',
  'gif.closePicker': 'Close GIF picker',
  'gif.searching': 'Searching…',
} as const

export type MsgKey = keyof typeof en

const es: Record<MsgKey, string> = {
  'common.cancel': 'Cancelar',
  'common.close': 'Cerrar',
  'common.copied': '¡Copiado!',
  'common.copyLink': 'Copiar enlace',
  'common.join': 'Entrar',
  'common.remove': 'Quitar',
  'common.retry': 'Reintentar',

  'movie.change': 'Cambiar película',
  'movie.pick': 'Elegir película',

  'library.privateScreening': 'Función privada',
  'library.gateA': 'Para ver la sesión necesitas el ',
  'library.gateRoomLink': 'enlace de sala',
  'library.gateB': ' que comparte el host — termina en ',
  'library.gateC': '. Pídeselo y ábrelo tal cual.',
  'library.roomCode': 'Código o enlace de la sala',
  'library.badRoomCode': 'Eso no parece un código de sala. Pega el enlace completo o el código que va tras /room/.',
  'library.hostHintA': '¿Eres el host? Entra con la URL con ',
  'library.hostHintB': ' que imprime la terminal al arrancar el servidor (se abre sola en el navegador).',
  'library.loadError': 'No se pudo cargar la biblioteca. ({error})',
  'library.loading': 'Encendiendo el proyector…',
  'library.settingUpFor': 'Montando la sala de «{title}»',
  'library.settingUp': 'Montando la sala…',
  'library.settingUpHint': 'Analizamos el vídeo y preparamos los subtítulos: con películas largas puede tardar unos segundos.',
  'library.linkCopiedHint': 'El enlace se copia al portapapeles en cuanto esté lista.',
  'library.createEmptyRoom': '🎬 Crear sala vacía',
  'library.addFolderBusy': '📁 Añadir carpeta…',
  'library.waiting': 'Esperando…',
  'library.folderDialogHint': 'Se abre el diálogo de tu sistema (mira el Finder/Explorador si no lo ves).',
  'library.typePath': 'O escribe la ruta a mano',
  'library.folderPathPlaceholder': '/ruta/absoluta/a/tus/vídeos',
  'library.folderPathLabel': 'Ruta de la carpeta de medios',
  'library.adding': 'Añadiendo…',
  'library.addFolder': 'Añadir carpeta',
  'library.marquee': 'La cartelera',
  'library.emptyNoFolders': 'Aún no hay nada en cartel: falta configurar carpetas de medios.',
  'library.emptyNoVideos': 'Las carpetas configuradas no contienen vídeos (MKV, MP4, AVI, M4V, WebM).',
  'library.addFirstFolder': 'Añade tu primera carpeta de medios',
  'library.mediaFolders': 'Carpetas de medios',
  'library.mediaFoldersCount': '⚙️ Carpetas de medios ({count})',
  'library.shareNow': 'Reparte el enlace ahora y elige la película dentro de la sala.',
  'library.settingUpShort': 'Montando…',
  'library.createRoom': 'Crear sala →',

  'room.notFound': 'Sala no encontrada',
  'room.notFoundHint': 'El enlace puede haber caducado. Pide al host uno nuevo.',
  'room.ticketTo': 'Tu entrada para',
  'room.theShow': 'la función',
  'room.yourName': 'Tu nombre',
  'room.prepareError': 'Error al preparar la sala',
  'room.tunnelDown': 'Túnel caído, relanzando…',
  'room.noMovie': 'Sala sin película',
  'room.copyLinkTitle': 'Copiar el enlace público de la sala ({url})',
  'room.movieInfo': 'Información de la película',
  'room.changeMovieTitle': 'Cambiar la película de la sala',
  'room.pickMovieTitle': 'Elegir la película de la sala',
  'room.copyFailed': 'No se pudo copiar solo. Cópialo a mano:',
  'room.publicLinkLabel': 'Enlace público de la sala',
  'room.noMovieYet': 'Sin película todavía',
  'room.pickWhatYouWatch': 'Elige qué vais a ver',
  'room.hostPicking': 'El host está eligiendo la película',
  'room.hostWaitingHint': 'Mientras tanto puedes copiar el enlace y repartirlo: la sala ya existe.',
  'room.guestWaitingHint': 'Puedes ir charlando en el chat; el vídeo aparecerá solo.',

  'chat.away': 'ausente',
  'chat.buffering': '{name} está cargando…',
  'chat.placeholder': 'Escribe un mensaje…',
  'chat.messageLabel': 'Mensaje de chat',
  'chat.send': 'Enviar',
  'chat.joined': '{name} se unió',
  'chat.left': '{name} salió',
  'chat.resumed': '{name} reanudó',
  'chat.paused': '{name} pausó',
  'chat.seek': '{name} saltó a {time}',
  'chat.nowPlaying': 'ahora se ve «{title}»',
  'chat.setBy': '{name} puso «{title}»',

  'player.noHls': 'Este navegador no puede reproducir HLS. Prueba con una versión reciente de Chrome, Firefox o Safari.',
  'player.play': 'Reproducir (espacio)',
  'player.pause': 'Pausar (espacio)',
  'player.mute': 'Silenciar',
  'player.unmute': 'Quitar silencio',
  'player.volume': 'Volumen',
  'player.volumePercent': 'Volumen {percent}%',
  'player.position': 'Posición en la película',
  'player.positionOf': '{position} de {duration}',
  'player.totalDuration': 'Duración total {duration}',
  'player.audioTrack': 'Pista de audio',
  'player.subtitles': 'Subtítulos',
  'player.noSubtitles': 'Sin subtítulos',
  'player.fullscreen': 'Pantalla completa (F)',
  'player.exitFullscreen': 'Salir de pantalla completa (F)',

  'meta.noSynopsis': 'Sin sinopsis disponible.',
  'meta.dataFromTmdb': 'Datos de TMDB',

  'picker.nowPlaying': ' · en emisión',
  'picker.externalOne': '1 subtítulo externo',
  'picker.externalMany': '{count} subtítulos externos',
  'picker.noExternalSubs': 'sin subtítulos externos',
  'picker.applyingTitle': '«{title}»',
  'picker.gettingReady': 'Preparándola para toda la sala: analizamos el vídeo y extraemos los subtítulos. Puede tardar unos segundos.',
  'picker.searchPlaceholder': 'Buscar por título…',
  'picker.searchLabel': 'Buscar película',
  'picker.confirmA': 'Vas a cambiar la película ',
  'picker.confirmForEveryone': 'para todos',
  'picker.confirmB': '. La reproducción empieza de cero y el chat se conserva.',
  'picker.playIt': 'Ponerla',
  'picker.loadingLibrary': 'Cargando la biblioteca…',
  'picker.noVideos': 'No hay vídeos en las carpetas configuradas.',
  'picker.noTitlesMatch': 'Ningún título coincide.',
  'picker.scanning': 'Escaneando…',
  'picker.rescan': '↻ Volver a escanear',

  'emoji.quickPicks': 'Tus accesos rápidos',
  'emoji.pickEmojis': 'Elegir emojis',
  'emoji.noneYet': 'Ninguno todavía: elige abajo los que quieras.',
  'emoji.remove': 'Quitar {emoji}',
  'emoji.max': 'Máximo {max}: quita alguno para añadir más.',
  'emoji.searchPlaceholder': 'Buscar emoji…',
  'emoji.searchLabel': 'Buscar emoji',
  'emoji.loading': 'Cargando emojis…',
  'emoji.noMatch': 'Ningún emoji coincide.',
  'emoji.group.0': 'Caras',
  'emoji.group.1': 'Gente',
  'emoji.group.3': 'Animales',
  'emoji.group.4': 'Comida',
  'emoji.group.5': 'Viajes',
  'emoji.group.6': 'Actividades',
  'emoji.group.7': 'Objetos',
  'emoji.group.8': 'Símbolos',
  'emoji.group.9': 'Banderas',

  'gif.searchPlaceholder': 'Buscar GIFs…',
  'gif.searchLabel': 'Buscar GIFs',
  'gif.closePicker': 'Cerrar buscador de GIFs',
  'gif.searching': 'Buscando…',
}

export const messages: Record<Lang, Record<MsgKey, string>> = { en, es }

export function translate(lang: Lang, key: MsgKey, vars?: Vars): string {
  const text = messages[lang][key]
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole))
}

// The override travels in the URL so the host can pin a language for a shared
// link; otherwise the browser's own preference list decides.
export const lang: Lang =
  (typeof location !== 'undefined' ? langFromSearch(location.search) : null)
  ?? detectLang(typeof navigator !== 'undefined' ? navigator.languages ?? navigator.language : undefined)

export const t = (key: MsgKey, vars?: Vars): string => translate(lang, key, vars)

if (typeof document !== 'undefined') document.documentElement.lang = lang
