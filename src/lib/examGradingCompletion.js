const text = value => String(value ?? '').trim().toLowerCase()

export const examGradeResultCompletesSession = result => (
  text(result?.session_status) === 'graded'
)

export function isExamGradingSessionCompleteError(error) {
  return [error?.code, error?.message, error?.details, error?.hint]
    .map(text)
    .some(value => value.includes('session_not_pending_grading'))
}
