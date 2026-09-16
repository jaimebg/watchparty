import { t } from './i18n'
import type { RoomMeta } from './types'

export function MetaModal({ meta, onClose }: { meta: RoomMeta; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <button className="modal-close" aria-label={t('common.close')} onClick={onClose}>✕</button>
        <div className="modal-body">
          {meta.posterUrl && <img className="modal-poster" src={meta.posterUrl} alt="" />}
          <div className="modal-text">
            <h2>{meta.title}{meta.year ? ` (${meta.year})` : ''}</h2>
            {meta.episodeTag && <p className="hint">{meta.episodeTag}</p>}
            {meta.rating !== null && <p className="modal-rating">★ {meta.rating.toFixed(1)} / 10</p>}
            <p className="modal-overview">{meta.overview || t('meta.noSynopsis')}</p>
            <p className="hint">{t('meta.dataFromTmdb')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
