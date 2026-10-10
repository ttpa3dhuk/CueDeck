let tail: Promise<unknown> = Promise.resolve()

/** Preparation writes SHA1-based temporary files; LibreOffice shares one process.
 * Serialize work so a live selection cannot remove a transfer's rebuilt source.
 */
export function runPptxWork<T>(work: () => Promise<T>): Promise<T> {
  const task = tail.then(work)
  tail = task.catch(() => undefined)
  return task
}
