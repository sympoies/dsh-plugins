/**
 * Asking whether the model can look at a picture before sending it one.
 *
 * A model that takes no image input rejects the whole request, so an
 * unchecked screenshot does not degrade — it fails the turn, and the user is
 * told their model "does not accept image input" by a layer that knows nothing
 * about Telegram or about what they were trying to do.
 *
 * The harness already publishes the answer: every model carries
 * `inputModalities`, defaulting to text alone. Reading it first turns a failed
 * turn into a sentence naming the models that would have worked.
 *
 * The check is best-effort in one direction only. A definite "no" refuses the
 * image; anything else — the catalog is unreachable, the model is unknown —
 * sends it and lets the provider be the authority, because a check that cannot
 * answer must not remove a capability the model may well have.
 */

/** What the harness knows about one model. */
export interface ModelInfo {
  readonly id: string
  readonly name?: string
  readonly inputModalities?: readonly string[]
}

/** The `ctx.llm` surface this needs. */
export interface ModelCatalog {
  resolveModelInfo(provider: string, model: string): Promise<ModelInfo>
  listModels(provider: string): Promise<readonly ModelInfo[]>
}

/** The route a conversation's agent is running on. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** Whether a model declares image input. */
export function acceptsImages(info: ModelInfo | undefined): boolean {
  return info?.inputModalities?.includes('image') === true
}

export class VisionCheck {
  constructor(
    private readonly catalog: ModelCatalog,
    /** The route in force right now, read late so a model change is picked up. */
    private readonly route: () => ModelRoute | undefined,
  ) {}

  /**
   * Whether an image may be sent on the current route.
   *
   * @returns `'yes'` when the model declares image input, `'no'` when it
   *   definitely does not, and `'unknown'` when the catalog could not say —
   *   in which case the caller should send and let the provider decide.
   */
  async verdict(): Promise<'yes' | 'no' | 'unknown'> {
    const route = this.route()
    if (!route) return 'unknown'

    try {
      const info = await this.catalog.resolveModelInfo(route.provider, route.model)
      if (info.inputModalities === undefined) return 'unknown'
      return acceptsImages(info) ? 'yes' : 'no'
    } catch {
      return 'unknown'
    }
  }

  /**
   * Models on the current provider that would accept the image.
   *
   * @returns their display names, or an empty list when none or unknown.
   */
  async alternatives(): Promise<string[]> {
    const route = this.route()
    if (!route) return []

    try {
      const models = await this.catalog.listModels(route.provider)
      return models.filter(acceptsImages).map((model) => model.name ?? model.id)
    } catch {
      return []
    }
  }

  /** The model an image would have been sent to, for naming it in a message. */
  currentModel(): string | undefined {
    return this.route()?.model
  }
}
