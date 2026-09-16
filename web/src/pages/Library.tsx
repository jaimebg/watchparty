import { useEffect, useState } from 'react'
import { addMediaFolder, bootstrapAdmin, createRoom, getLibrary, getMediaFolders, getStatus, pickMediaFolder, removeMediaFolder } from '../api'
import { t } from '../i18n'
import type { LibraryItem } from '../types'
import { parseRoomToken, roomLink } from './roomToken'

export function Library() {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [guest, setGuest] = useState(false)
  const [folderPath, setFolderPath] = useState('')
  const [folderError, setFolderError] = useState<string | null>(null)
  const [busyFolders, setBusyFolders] = useState(false)
  const [roomInput, setRoomInput] = useState('')
  const [roomError, setRoomError] = useState<string | null>(null)
  // null = nothing under way. The object describes the room being built:
  // `id`/`title` are null for an empty room, which prepares no video.
  const [starting, setStarting] = useState<{ id: string | null; title: string | null } | null>(null)

  const load = async () => {
    try {
      if (await bootstrapAdmin(location.search)) history.replaceState(null, '', location.pathname)
      setItems(await getLibrary())
      setFolders(await getMediaFolders())
    } catch (e) {
      // 401 = a visitor with no admin cookie: typically a guest who opened the
      // base public URL instead of the room link. Not an error, just a landing
      // page.
      if (e instanceof Error && e.message.includes('401')) setGuest(true)
      else setError(String(e))
    }
  }

  // No item means an empty room. The link is still copied, so the host can hand
  // it around and pick a movie with people already inside.
  const start = async (item?: LibraryItem) => {
    // With a movie, `createRoom` does not return until the server has probed the
    // video, pulled the keyframes and extracted the subtitles: seconds. Re-entry
    // is blocked because two impatient clicks would create two rooms and the
    // copied link would be the second one's.
    if (starting) return
    setStarting({ id: item?.id ?? null, title: item?.title ?? null })
    try {
      const { token } = await createRoom(item?.id)
      const { tunnelUrl } = await getStatus()
      await navigator.clipboard.writeText(roomLink(tunnelUrl ?? location.origin, token)).catch(() => {})
      // `starting` is deliberately not cleared: navigation takes a moment to
      // paint and the card has to stay up until the page goes away.
      location.pathname = `/room/${token}`
    } catch (e) {
      setStarting(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Any folder operation returns the rescanned library; the folder list is
  // refreshed separately (a stable contract with the server).
  const folderOp = async (op: () => Promise<LibraryItem[] | null>) => {
    setBusyFolders(true)
    setFolderError(null)
    try {
      const list = await op()
      if (list) setItems(list)
      setFolders(await getMediaFolders())
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyFolders(false)
    }
  }

  const submitFolder = () => {
    const trimmed = folderPath.trim()
    if (!trimmed) return
    void folderOp(async () => {
      const list = await addMediaFolder(trimmed)
      setFolderPath('')
      return list
    })
  }

  useEffect(() => { void load() }, [])

  if (guest) {
    const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname)
    const enterRoom = () => {
      const token = parseRoomToken(roomInput)
      if (!token) { setRoomError(t('library.badRoomCode')); return }
      location.pathname = `/room/${token}`
    }
    return (
      <main className="page page--gate">
        <header className="masthead">
          <p className="eyebrow">Watchparty</p>
          <h1>{t('library.privateScreening')}</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p>{t('library.gateA')}<strong>{t('library.gateRoomLink')}</strong>{t('library.gateB')}<code>/room/…</code>{t('library.gateC')}</p>
        <form className="name-form" onSubmit={e => { e.preventDefault(); enterRoom() }}>
          <input
            value={roomInput}
            onChange={e => { setRoomInput(e.target.value); setRoomError(null) }}
            placeholder={t('library.roomCode')}
            aria-label={t('library.roomCode')}
          />
          <button type="submit" className="btn-primary">{t('common.join')}</button>
        </form>
        {roomError && <p className="field-error">{roomError}</p>}
        {isLocal && (
          <p className="hint">{t('library.hostHintA')}<code>?key=…</code>{t('library.hostHintB')}</p>
        )}
      </main>
    )
  }

  if (error) return (
    <main className="page">
      <p>{t('library.loadError', { error })}</p>
    </main>
  )
  if (!items) return <main className="page"><p className="loading">{t('library.loading')}</p></main>

  // Fixed over the whole page, so it mounts the same in both marquee views
  // (with titles and without) wherever it lands in the tree.
  const startingOverlay = starting && (
    <div className="busy-overlay" role="status" aria-live="polite">
      <span className="spinner spinner--lg" aria-hidden="true" />
      <p className="busy-title">
        {starting.title ? t('library.settingUpFor', { title: starting.title }) : t('library.settingUp')}
      </p>
      {starting.title && (
        <p className="hint">{t('library.settingUpHint')}</p>
      )}
      <p className="hint">{t('library.linkCopiedHint')}</p>
    </div>
  )

  const emptyRoomButton = (
    <button type="button" className="btn-primary" disabled={starting !== null} onClick={() => void start()}>
      {starting && starting.id === null
        ? <><span className="spinner" aria-hidden="true" /> {t('library.settingUp')}</>
        : t('library.createEmptyRoom')}
    </button>
  )

  const foldersSection = (
    <section className="folders-box">
      {folders.length > 0 && (
        <ul className="folders-list">
          {folders.map(f => (
            <li key={f}>
              <code>{f}</code>
              <button type="button" className="btn-small" disabled={busyFolders}
                onClick={() => void folderOp(() => removeMediaFolder(f))}>{t('common.remove')}</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-primary" onClick={() => void folderOp(pickMediaFolder)} disabled={busyFolders}>
        {busyFolders ? t('library.waiting') : t('library.addFolderBusy')}
      </button>
      <p className="hint">{t('library.folderDialogHint')}</p>
      <details>
        <summary>{t('library.typePath')}</summary>
        <form className="name-form" onSubmit={e => { e.preventDefault(); submitFolder() }}>
          <input
            value={folderPath}
            onChange={e => setFolderPath(e.target.value)}
            placeholder={t('library.folderPathPlaceholder')}
            aria-label={t('library.folderPathLabel')}
          />
          <button type="submit" disabled={busyFolders}>{busyFolders ? t('library.adding') : t('library.addFolder')}</button>
        </form>
      </details>
      {folderError && <p className="field-error">{folderError}</p>}
    </section>
  )

  if (items.length === 0) {
    return (
      <main className="page">
        <header className="masthead">
          <p className="eyebrow">Watchparty</p>
          <h1>{t('library.marquee')}</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p>{folders.length === 0
          ? t('library.emptyNoFolders')
          : t('library.emptyNoVideos')}</p>
        <p>{emptyRoomButton}</p>
        <h2>{folders.length === 0 ? t('library.addFirstFolder') : t('library.mediaFolders')}</h2>
        {foldersSection}
        {startingOverlay}
      </main>
    )
  }

  // By folderPath and not folderName: two series each with a "Season 1" would be
  // merged into one section with both sets of episodes mixed together.
  const groups = [...new Map(items.map(i => [i.folderPath, i.folderName])).entries()]
  return (
    <main className="page">
      <header className="masthead">
        <p className="eyebrow">Watchparty</p>
          <h1>{t('library.marquee')}</h1>
          <div className="marquee-rule" aria-hidden="true" />
        </header>
        <p className="hint">
          {emptyRoomButton}
          {' '}{t('library.shareNow')}
      </p>
      {groups.map(([path, name]) => (
        <section key={path} className="bill">
          <h2>{name}</h2>
          <ul className="film-list">{items.filter(i => i.folderPath === path).map((i, idx) => (
            <li key={i.id} style={{ animationDelay: `${Math.min(idx, 10) * 45}ms` }}>
              <button type="button" className="film-btn" disabled={starting !== null} onClick={() => void start(i)}>
                <span className="film-title">{i.title}</span>
                {starting?.id === i.id ? (
                  <span className="film-go film-go--busy" aria-hidden="true">
                    <span className="spinner" /> {t('library.settingUpShort')}
                  </span>
                ) : (
                  <span className="film-go" aria-hidden="true">{t('library.createRoom')}</span>
                )}
              </button>
            </li>
          ))}</ul>
        </section>
      ))}
      <details className="folders-manage">
        <summary>{t('library.mediaFoldersCount', { count: folders.length })}</summary>
        {foldersSection}
      </details>
      {startingOverlay}
    </main>
  )
}
