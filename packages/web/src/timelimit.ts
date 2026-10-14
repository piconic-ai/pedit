/**
 * Names a relay's room time limit, or just "time limit" when the relay did not
 * say. The same rules as timeLimitText in cmd/pedit/ui.go.
 */
export function timeLimitText(seconds?: number): string {
  if (!seconds || seconds <= 0) return 'time limit'
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour limit`
  if (seconds % 60 === 0) return `${seconds / 60}-minute limit`
  return `${seconds}-second limit`
}
