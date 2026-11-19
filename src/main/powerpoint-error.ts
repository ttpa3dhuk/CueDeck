export class PowerpointExportError extends Error {
  constructor(message: string, readonly uncertain = false, readonly missing = false) { super(message) }
}
