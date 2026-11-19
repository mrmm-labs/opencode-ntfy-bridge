/** Connector types by name. A new connector is one file plus one line here. */
import { ntfyType } from "./ntfy.ts"
import { telegramType } from "./telegram.ts"
import type { ConnectorType } from "./types.ts"

export const connectorTypes: Record<string, ConnectorType<any>> = {
  ntfy: ntfyType,
  telegram: telegramType,
}
