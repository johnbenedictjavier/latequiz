import { useEffect, useState } from 'react'
import { signedSubmissionUrl } from '../lib/submissionUploads'
import { LEGACY_REVIEW_NOTICE, submissionImageMode } from '../lib/submissionReview'

type LoadState = { status: 'loading' } | { status: 'ready'; url: string } | { status: 'error' }

/**
 * Admin view of an upload answer. Legacy bare names show the name and a notice without any storage
 * call; real object paths get a fresh 300 s signed URL each time this component mounts for the answer.
 */
export function SubmissionImage({ path, questionNumber }: { path: string | null | undefined; questionNumber: number }) {
  const mode = submissionImageMode(path)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    if (mode !== 'stored') return
    let active = true
    setState({ status: 'loading' })
    setImageFailed(false)
    void signedSubmissionUrl(path).then(({ url, error }) => {
      if (!active) return
      setState(url && !error ? { status: 'ready', url } : { status: 'error' })
    })
    return () => { active = false }
  }, [mode, path])

  if (mode === 'empty') return <div className="student-answer"><span>Answer:</span><strong>No image submitted</strong></div>

  if (mode === 'legacy') {
    return <div className="submission-image submission-image-legacy"><div className="student-answer"><span>File name:</span><strong>{path}</strong></div><p className="info-callout" role="note">{LEGACY_REVIEW_NOTICE}</p></div>
  }

  if (state.status === 'loading') return <div className="submission-image" aria-busy="true"><span>Loading image...</span></div>

  if (state.status === 'error' || imageFailed) {
    return <div className="submission-image submission-image-missing" role="status"><strong>Image unavailable</strong><code>{path}</code></div>
  }

  return <figure className="submission-image"><img src={state.url} alt={`Student upload for question ${questionNumber}`} onError={() => setImageFailed(true)} style={{ maxWidth: '100%', height: 'auto' }} /><figcaption><a href={state.url} target="_blank" rel="noopener noreferrer">Open full size</a></figcaption></figure>
}
