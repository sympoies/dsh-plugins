/**
 * Driving harness agents.
 *
 * This is the one module that reaches into `ctx.agents`, so the rest of the
 * plugin can be tested without a harness. It translates between the harness's
 * ownership model and the flat {@link RunningAgent} the session runner wants.
 *
 * The distinction that matters is who may tear an agent down. `ctx.agents.get`
 * returns a bare agent that anyone can observe but nobody can dispose;
 * `create`/`resume` return a handle whose disposer is a capability. So handles
 * are kept for the agents this plugin created, and a bare agent found in the
 * registry is borrowed and left alone — disposing something another owner
 * created would pull the session out from under them.
 */

import type { Logger } from './types.js'
import type { AgentHost, RunningAgent } from '../session/runner.js'
import type { MessageFactory } from './message.js'
import type { AgentContextLike, MutableSelection } from './model-selection.js'
import { sameRoute } from './model-selection.js'

/** A bare agent from the registry. */
interface HarnessAgentLike {
  readonly id: string
  followup(message: unknown): void
  cancel(cause: string, options?: { keepInbox?: boolean }): void
}

/** An owned agent plus its disposer. */
interface HarnessAgentHandle {
  readonly agent: HarnessAgentLike
  dispose(): Promise<void>
}

/** What this plugin keeps for an agent it owns. */
interface OwnedAgent {
  readonly handle: HarnessAgentHandle
  /** Mutated to move the next step onto another model; undefined = its own. */
  readonly selection: MutableSelection
}

/** The model route an agent opens its requests on. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/**
 * The preset roster, narrowed to what one agent's composition needs.
 *
 * A preset is where the tools live. The registries themselves are host-plane,
 * but almost every model-facing row — bash, the editor, grep, skills,
 * subagents, todo, plan mode — is registered into the PRESET's scope layer, so
 * an agent that joins no preset reaches the model with only whatever the host
 * composition registered globally. In this deployment that is the web tools
 * and nothing else.
 */
export interface AgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

/** The `ctx.agents` surface this plugin uses. */
export interface AgentRegistryLike {
  get(sessionId: string): HarnessAgentLike | undefined
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: ModelRoute
    setup?: (agentCtx: unknown) => void | Promise<void>
  }): Promise<HarnessAgentHandle>
  resume(options: {
    resumeSessionId: string
    agentOptions?: ModelRoute
    setup?: (agentCtx: unknown) => void | Promise<void>
  }): Promise<HarnessAgentHandle>
}

/** Construction options. */
export interface HarnessAgentHostOptions {
  readonly agents: AgentRegistryLike
  readonly message: MessageFactory
  /**
   * The deployment's model route, read at creation time rather than captured,
   * so a default changed in Settings reaches the next conversation.
   *
   * An agent created without one has no route to name, and prompt assembly
   * fails the turn on an empty `{{model}}` variable — a failure that surfaces
   * as a broken reply rather than as anything about models.
   */
  readonly selectModel?: () => ModelRoute | undefined
  /**
   * Installs the mutable model selection into a new agent's scope. Absent
   * leaves every turn on the session's own route.
   */
  readonly installSelection?: (agentCtx: AgentContextLike, selection: MutableSelection) => void
  /**
   * The preset roster, where the deployment composes one. Absent is a real
   * deployment shape — the harness's own agent factory handles it too — and
   * means the agent gets whatever the host composition registered globally.
   */
  readonly presets?: AgentPresetsLike
  /** Preset to compose Telegram agents from; absent takes the roster default. */
  readonly presetId?: () => string | undefined
  readonly logger?: Logger
}

/**
 * Build an {@link AgentHost} over the live harness registry.
 *
 * @param options - the registry, the message factory, and a logger.
 */
export function createAgentHost(options: HarnessAgentHostOptions): AgentHost {
  /** Agents this plugin owns, so it can dispose and re-route exactly those. */
  const owned = new Map<string, OwnedAgent>()

  const wrap = (agent: HarnessAgentLike, sessionId: string): RunningAgent => ({
    sessionId,

    followup(content) {
      agent.followup(options.message(content))
    },

    useModel(route) {
      const entry = owned.get(sessionId)
      // A borrowed agent carries no selection of ours; its route is its own.
      if (!entry) return false
      if (sameRoute(entry.selection.current, route)) return true

      entry.selection.current = route
      return true
    },

    cancel(reason: string) {
      agent.cancel(reason)
    },

    async dispose() {
      const entry = owned.get(sessionId)
      owned.delete(sessionId)
      // Only an owner may dispose. A borrowed agent is simply released.
      if (entry) await entry.handle.dispose()
    },
  })

  const adopt = (
    handle: HarnessAgentHandle,
    sessionId: string,
    selection: MutableSelection,
  ): RunningAgent => {
    owned.set(sessionId, { handle, selection })
    return wrap(handle.agent, sessionId)
  }

  /**
   * Everything one new agent needs composed into it.
   *
   * The preset is resolved here, before the agent exists, so a bad id fails
   * the creation rather than half-composing a session. The mount itself must
   * happen inside `setup`, which is the one place the agent is still
   * unpublished and a rejected composition can roll the whole thing back.
   */
  const prepareAgent = async () => {
    const selection: MutableSelection = { current: undefined }
    const install = options.installSelection

    let preset: string | undefined
    if (options.presets) {
      try {
        preset = (await options.presets.resolve(options.presetId?.())).id
      } catch (error) {
        // A named preset that has gone is not worth failing a message over;
        // the roster's own default still composes a usable agent.
        options.logger?.warn('[dsh-telegram] could not resolve the agent preset', error)
        preset = (await options.presets.resolve().catch(() => undefined))?.id
      }
    }

    // The braces matter. The harness calls `.commit()` on whatever setup
    // returns, so handing back the installer's disposer — as an
    // expression-bodied arrow would — crashes agent creation on a function
    // that has no such method. An async body resolving to undefined is fine.
    //
    // Dropping the disposer is right anyway: the listeners live on the
    // agent's own scope and unwind when the agent does.
    const setup = async (agentCtx: unknown): Promise<void> => {
      if (install) install(agentCtx as AgentContextLike, selection)
      if (options.presets) await options.presets.mount(agentCtx, preset)
    }

    return {
      selection,
      ...(install || options.presets ? { setup } : {}),
      ...(preset === undefined ? {} : { preset }),
    }
  }

  return {
    live(sessionId) {
      const owner = owned.get(sessionId)
      if (owner) return wrap(owner.handle.agent, sessionId)

      const bare = options.agents.get(sessionId)
      return bare ? wrap(bare, sessionId) : undefined
    },

    async create(sessionId, cwd, forced) {
      // A forced route comes from a caller that knows which model it needs —
      // reading an image — and outranks the deployment's default.
      const route = forced ?? options.selectModel?.()
      const prepared = await prepareAgent()
      const handle = await options.agents.create({
        sessionId,
        // Recorded so a later reader — a cold transcript, the web UI's session
        // list — resolves the same composition this agent runs on.
        meta: { cwd, ...(prepared.preset === undefined ? {} : { agentPreset: prepared.preset }) },
        ...(route ? { agentOptions: route } : {}),
        ...(prepared.setup ? { setup: prepared.setup } : {}),
      })
      return adopt(handle, sessionId, prepared.selection)
    },

    async resume(sessionId) {
      try {
        // Supplied on resume too, matching the harness's own entry points: a
        // log that already names a selection keeps it, and one that does not
        // — such as a session created before this route existed — is repaired.
        const route = options.selectModel?.()
        const prepared = await prepareAgent()
        const handle = await options.agents.resume({
          resumeSessionId: sessionId,
          ...(route ? { agentOptions: route } : {}),
          ...(prepared.setup ? { setup: prepared.setup } : {}),
        })
        return adopt(handle, sessionId, prepared.selection)
      } catch (error) {
        // A pruned, moved, or incompatible log is an ordinary outcome here; the
        // runner starts a fresh conversation rather than failing the message.
        options.logger?.debug(`[dsh-telegram] resume of '${sessionId}' failed`, error)
        return undefined
      }
    },
  }
}
