import type { Quiz, Student, Submission, SubmissionPartColumn } from '../types'

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatPoints(value: number) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

function formatTime(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return '—'
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return minutes ? `${minutes}m ${remaining}s` : `${remaining}s`
}

function partColumnsForQuiz(quiz: Quiz): SubmissionPartColumn[] {
  const columns: SubmissionPartColumn[] = (quiz.parts ?? []).map((part) => ({
    partId: part.id,
    title: part.title,
    position: part.position,
    possiblePoints: part.questions.reduce((sum, question) => sum + Number(question.points || 0), 0),
  }))
  const generalPoints = (quiz.questionsList ?? []).filter((question) => !question.partId).reduce((sum, question) => sum + Number(question.points || 0), 0)
  if (generalPoints) columns.push({ partId: null, title: 'General', position: columns.length + 1, possiblePoints: generalPoints })
  return columns.sort((left, right) => left.position - right.position)
}

function latestSubmission(submissions: Submission[], schoolId: string) {
  return submissions
    .filter((submission) => submission.student.schoolId === schoolId)
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0]
}

export function exportSubmissionReportPdf(quiz: Quiz, assignedStudents: Student[], submissions: Submission[]) {
  const reportWindow = window.open('', '_blank', 'noopener,noreferrer')
  if (!reportWindow) return false

  const columns = partColumnsForQuiz(quiz)
  const rows = assignedStudents.map((student) => {
    const submission = latestSubmission(submissions, student.schoolId)
    const cells = columns.map((column) => {
      const part = submission?.parts?.find((item) => (item.partId ?? '__general') === (column.partId ?? '__general'))
      return part ? `${formatPoints(part.earned)} / ${formatPoints(part.possible)}` : '—'
    })
    const totalPossible = columns.reduce((sum, column) => sum + column.possiblePoints, 0)
    const totalEarned = submission?.earnedPoints ?? 0
    return `<tr><td>${escapeHtml(`${student.lastName}, ${student.firstNames}`)}</td>${cells.map((cell) => `<td>${cell}</td>`).join('')}<td>${submission ? `${formatPoints(totalEarned)} / ${formatPoints(totalPossible)}` : '—'}</td><td>${submission ? escapeHtml(submissionStatus(submission)) : 'Not started'}</td><td>${formatTime(submission?.timeTakenSeconds)}</td></tr>`
  }).join('')

  const headingColumns = columns.map((column) => `<th>${escapeHtml(column.title)}<small>${formatPoints(column.possiblePoints)} pts</small></th>`).join('')
  reportWindow.document.write(`<!doctype html><html><head><title>${escapeHtml(quiz.title)} submission report</title><style>
    @page { size: landscape; margin: 12mm; }
    * { box-sizing: border-box; }
    body { color: #1d2540; font-family: Arial, sans-serif; margin: 0; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    p { color: #68728b; font-size: 11px; margin: 0 0 18px; }
    table { border-collapse: collapse; font-size: 10px; width: 100%; }
    th, td { border: 1px solid #dfe3ec; padding: 7px 8px; text-align: left; }
    th { background: #f1f2f8; font-size: 9px; text-transform: uppercase; }
    th small { color: #8992a7; display: block; font-size: 8px; margin-top: 3px; text-transform: none; }
    td:not(:first-child) { white-space: nowrap; }
    .meta { display: flex; gap: 16px; margin-bottom: 5px; }
    .meta span { color: #68728b; font-size: 10px; }
    @media print { .no-print { display: none; } }
  </style></head><body><h1>${escapeHtml(quiz.title)}</h1><p>${escapeHtml(quiz.subject)} · Raw point report · Generated ${escapeHtml(new Date().toLocaleString())}</p><div class="meta"><span>Assigned: ${assignedStudents.length}</span><span>Submitted: ${assignedStudents.filter((student) => Boolean(latestSubmission(submissions, student.schoolId))).length}</span></div><table><thead><tr><th>Student</th>${headingColumns}<th>Total points</th><th>Status</th><th>Time taken</th></tr></thead><tbody>${rows || '<tr><td colspan="99">No assigned students</td></tr>'}</tbody></table><button class="no-print" onclick="window.print()" style="margin-top:18px;padding:8px 13px">Print or save as PDF</button></body></html>`)
  reportWindow.document.close()
  reportWindow.focus()
  return true
}

function submissionStatus(submission: Submission) {
  if (submission.status === 'in-progress') return 'In progress'
  if (submission.status === 'graded') return 'Graded'
  return 'Needs review'
}
