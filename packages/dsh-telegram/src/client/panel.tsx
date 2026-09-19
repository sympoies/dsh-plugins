/**
 * The Settings → Telegram page.
 *
 * Every control writes straight through to the host settings document; there
 * is no Save button and no local draft, because the host applies a committed
 * change by reconnecting, and a form that stages edits would let the page and
 * the running bot disagree about what is configured.
 *
 * The token is the exception, and deliberately so: it is a secret, so it never
 * rides the settings wire in either direction. The page can only learn whether
 * one is stored, and writes it through the credentials domain — the same route
 * the built-in Models page uses for provider API keys.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button, Note, NumberInput, Row, Section, Select, TextInput, Toggle } from './fields.js'
import type { SelectOption } from './fields.js'
import type { LocaleKey } from './locale.js'
import type { CatalogGroup, CredentialsRemote, SettingsScope, SettingsSnapshot } from './types.js'

/** The section of settings this page edits. */
export interface TelegramSettings {
  enabled: boolean
  tokenRef: string
  baseUrl: string
  allowFrom: number[]
  cwd: string
  timeoutMs: number
  longPollSeconds: number
  streaming: { enabled: boolean; throttleMs: number }
  media: { enabled: boolean; maxBytes: number; maxTextChars: number; visionModel: string }
  screenshot: { enabled: boolean }
  reconnect: { baseDelayMs: number; maxDelayMs: number }
}

/** What the page needs to render and to write. */
export interface PanelProps {
  readonly scope: SettingsScope<TelegramSettings>
  readonly remote: CredentialsRemote
  readonly t: (key: LocaleKey, params?: Record<string, unknown>) => string
}

export function TelegramPanel({ scope, remote, t }: PanelProps) {
  const snapshot = useSettingsSnapshot(scope)
  const [failure, setFailure] = useState<string | undefined>()

  const write = useCallback(
    (field: string, value: unknown) => {
      setFailure(undefined)
      void scope.set(field, value).catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
      })
    },
    [scope],
  )

  const clear = useCallback(
    (field: string) => {
      setFailure(undefined)
      void scope.unset(field).catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
      })
    },
    [scope],
  )

  if (snapshot.status === 'loading') return <Page t={t}><Note tone="info">{t('loading')}</Note></Page>
  if (snapshot.status === 'unavailable' || snapshot.mode === 'memory') {
    return <Page t={t}><Note tone="warn">{t('unavailable')}</Note></Page>
  }

  const value = snapshot.value
  if (!value) return <Page t={t}><Note tone="info">{t('loading')}</Note></Page>

  const locked = !snapshot.writable
  const overridden = (field: string) => isOverridden(snapshot.user, field)

  /** Write one field of a nested object by replacing the whole object. */
  const writeNested = <K extends 'streaming' | 'media' | 'reconnect' | 'screenshot'>(
    parent: K,
    patch: Partial<TelegramSettings[K]>,
  ) => write(parent, { ...value[parent], ...patch })

  return (
    <Page t={t}>
      {locked ? <Note tone="warn">{t('readonly')}</Note> : null}
      {failure ? <Note tone="bad">{t('saveFailed', { reason: failure })}</Note> : null}

      <Section title={t('connectionTitle')}>
        <Row
          label={t('enabled')}
          hint={t('enabledHint')}
          overridden={overridden('enabled')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onReset={() => clear('enabled')}
        >
          <Toggle
            checked={value.enabled}
            disabled={locked}
            onChange={(next) => write('enabled', next)}
          />
        </Row>

        <TokenRow ref_={value.tokenRef} remote={remote} t={t} locked={locked} />

        <Row
          label={t('tokenRef')}
          hint={t('tokenRefHint')}
          overridden={overridden('tokenRef')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onReset={() => clear('tokenRef')}
        >
          <CommittedText value={value.tokenRef} disabled={locked} onCommit={(next) => write('tokenRef', next)} />
        </Row>

        <Row
          label={t('baseUrl')}
          hint={t('baseUrlHint')}
          overridden={overridden('baseUrl')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onReset={() => clear('baseUrl')}
        >
          <CommittedText value={value.baseUrl} disabled={locked} onCommit={(next) => write('baseUrl', next)} />
        </Row>
      </Section>

      <Section title={t('accessTitle')}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.28))' }}>
          <Note tone="warn">{t('accessWarning')}</Note>
        </div>
        <AllowListRow
          ids={value.allowFrom}
          locked={locked}
          overridden={overridden('allowFrom')}
          t={t}
          onCommit={(ids) => write('allowFrom', ids)}
          onReset={() => clear('allowFrom')}
        />
      </Section>

      <Section title={t('mediaTitle')}>
        <Row
          label={t('mediaEnabled')}
          hint={t('mediaHint')}
          overridden={overridden('media')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onReset={() => clear('media')}
        >
          <Toggle
            checked={value.media.enabled}
            disabled={locked}
            onChange={(next) => writeNested('media', { enabled: next })}
          />
        </Row>

        <VisionModelRow
          value={value.media.visionModel ?? ''}
          remote={remote}
          t={t}
          disabled={locked || !value.media.enabled}
          onChange={(next) => writeNested('media', { visionModel: next })}
        />
      </Section>

      <Section title={t('screenTitle')}>
        <Row
          label={t('screenshotEnabled')}
          hint={t('screenshotHint')}
          overridden={overridden('screenshot')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onReset={() => clear('screenshot')}
        >
          <Toggle
            checked={value.screenshot.enabled}
            disabled={locked}
            onChange={(next) => writeNested('screenshot', { enabled: next })}
          />
        </Row>
      </Section>

      <Section title={t('repliesTitle')}>
        <Row
          label={t('streamingEnabled')}
          hint={t('streamingHint')}
          overridden={overridden('streaming')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onReset={() => clear('streaming')}
        >
          <Toggle
            checked={value.streaming.enabled}
            disabled={locked}
            onChange={(next) => writeNested('streaming', { enabled: next })}
          />
        </Row>

        <Row label={t('throttle')} hint={t('throttleHint')}>
          <NumberInput
            value={value.streaming.throttleMs}
            disabled={locked}
            onCommit={(next) => writeNested('streaming', { throttleMs: next })}
          />
        </Row>

      </Section>

      <Section title={t('advancedTitle')}>
        <Row
          label={t('cwd')}
          hint={t('cwdHint')}
          overridden={overridden('cwd')}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          onReset={() => clear('cwd')}
        >
          <CommittedText value={value.cwd ?? ''} width={280} disabled={locked} onCommit={(next) => write('cwd', next)} />
        </Row>

        <Row label={t('longPoll')}>
          <NumberInput
            value={value.longPollSeconds}
            min={1}
            disabled={locked}
            onCommit={(next) => write('longPollSeconds', next)}
          />
        </Row>

        <Row label={t('timeout')}>
          <NumberInput
            value={value.timeoutMs}
            min={1000}
            disabled={locked}
            onCommit={(next) => write('timeoutMs', next)}
          />
        </Row>
      </Section>
    </Page>
  )
}

/** Page chrome shared by the loading, unavailable, and ready states. */
function Page(props: { t: (key: LocaleKey) => string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 720, padding: '8px 4px 40px' }}>
      <h2 style={{ margin: '0 0 6px', fontSize: 20, color: 'var(--dsw-alias-label-primary, currentColor)' }}>
        {props.t('heading')}
      </h2>
      <p style={{ margin: '0 0 24px', fontSize: 13, color: 'var(--dsw-alias-label-secondary, #6b7280)' }}>
        {props.t('subheading')}
      </p>
      {props.children}
    </div>
  )
}

/**
 * What the token control knows, and what it is allowed to say.
 *
 * Three states, kept apart on purpose. Conflating "the check failed" with "the
 * host says it is read-only" is how this control came to announce that a token
 * was supplied by the environment when in truth the answer had simply not been
 * read correctly — a confident, wrong explanation is worse than no explanation.
 */
export type TokenState =
  | { kind: 'checking' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'known'; configured: boolean; writable: boolean; source?: string }

/** How the control should present one token state. */
export interface TokenPresentation {
  readonly hint: LocaleKey
  readonly params?: Record<string, unknown>
  /** Whether the user may type a new token. */
  readonly editable: boolean
  /** Whether to offer re-running the check. */
  readonly retryable: boolean
  /** Whether to offer removing the stored token. */
  readonly removable: boolean
}

/**
 * Decide what to show for a token state.
 *
 * Pure, so the decision is testable without a browser — which is where the
 * wrong message lived last time.
 *
 * @param state - what the host answered, or that it did not.
 * @param locked - whether the settings document itself refuses writes.
 */
export function presentToken(state: TokenState, locked: boolean): TokenPresentation {
  if (state.kind === 'checking') {
    return { hint: 'tokenChecking', editable: false, retryable: false, removable: false }
  }

  if (state.kind === 'unknown') {
    return {
      hint: 'tokenCheckFailed',
      params: { reason: state.reason },
      editable: false,
      retryable: true,
      removable: false,
    }
  }

  if (!state.writable) {
    // Only the environment layer is worth naming; anything else is just
    // read-only, and guessing which would repeat the original mistake.
    return {
      hint: state.source === 'env' ? 'tokenFromEnvironment' : 'tokenReadOnly',
      editable: false,
      retryable: false,
      removable: false,
    }
  }

  return {
    hint: state.configured ? 'tokenConfigured' : 'tokenMissing',
    editable: !locked,
    retryable: false,
    removable: state.configured && !locked,
  }
}

/**
 * The bot token.
 *
 * Only ever reports whether one is stored — a secret never rides back over the
 * wire — and refuses to offer an edit for a reference the environment supplies,
 * because a write there would appear to succeed while resolution kept returning
 * the shadowing value.
 */
function TokenRow(props: {
  ref_: string
  remote: CredentialsRemote
  t: (key: LocaleKey, params?: Record<string, unknown>) => string
  locked: boolean
}) {
  const { ref_, remote, t } = props
  const [state, setState] = useState<TokenState>({ kind: 'checking' })
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()

  const refresh = useCallback(() => {
    setState({ kind: 'checking' })
    void remote.credentials
      .describe({ refs: [ref_] })
      .then((answer) => {
        if (!answer.result.ok) {
          return setState({ kind: 'unknown', reason: answer.result.error.message })
        }
        const info = answer.result.value.credentials[ref_]
        if (!info) {
          return setState({ kind: 'known', configured: false, writable: true })
        }
        setState({
          kind: 'known',
          configured: info.configured,
          writable: info.writable,
          ...(info.source !== undefined ? { source: info.source } : {}),
        })
      })
      .catch((error: unknown) => {
        setState({ kind: 'unknown', reason: error instanceof Error ? error.message : String(error) })
      })
  }, [remote, ref_])

  useEffect(refresh, [refresh])

  const view = presentToken(state, props.locked)

  const save = () => {
    if (draft === '') return
    setFailure(undefined)
    void remote.credentials
      .set({ ref: ref_, value: draft })
      .then((answer) => {
        if (!answer.result.ok) return setFailure(answer.result.error.message)
        setDraft('')
        setSaved(true)
        refresh()
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
  }

  const remove = () => {
    setFailure(undefined)
    void remote.credentials
      .unset({ ref: ref_ })
      .then((answer) => {
        if (!answer.result.ok) return setFailure(answer.result.error.message)
        setSaved(false)
        refresh()
      })
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
  }

  return (
    <Row label={t('tokenTitle')} hint={t(view.hint, view.params)}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <TextInput
            type="password"
            value={draft}
            onChange={setDraft}
            onCommit={save}
            placeholder={t('tokenPlaceholder')}
            disabled={!view.editable}
          />
          <Button onClick={save} disabled={!view.editable || draft === ''}>
            {t('tokenSave')}
          </Button>
        </div>
        {view.retryable ? <Button onClick={refresh}>{t('tokenRetry')}</Button> : null}
        {view.removable ? (
          <Button onClick={remove} tone="danger">
            {t('tokenClear')}
          </Button>
        ) : null}
        {saved ? <Note tone="good">{t('tokenSaved')}</Note> : null}
        {failure ? <Note tone="bad">{failure}</Note> : null}
      </div>
    </Row>
  )
}

/**
 * Which model a turn carrying an image runs on.
 *
 * A dropdown over the models already configured in Settings → Models, rather
 * than a typed `provider/model`: the set is knowable, and a typo there is only
 * discovered when a screenshot silently goes nowhere.
 *
 * The catalog carries no modality information, so this cannot mark which
 * models accept images. The host checks that when an image is actually sent
 * and says so in the chat, which is the one place the answer is certain.
 */
function VisionModelRow(props: {
  value: string
  remote: CredentialsRemote
  t: (key: LocaleKey, params?: Record<string, unknown>) => string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const { remote, t } = props
  const [groups, setGroups] = useState<readonly CatalogGroup[] | undefined>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let stale = false
    void remote.llm
      .models({})
      .then((answer) => {
        if (stale) return
        if (!answer.result.ok) return setFailed(true)
        setGroups(answer.result.value.groups)
      })
      .catch(() => {
        if (!stale) setFailed(true)
      })
    return () => {
      stale = true
    }
  }, [remote])

  const options = useMemo(() => {
    const listed: SelectOption[] = [{ value: '', label: t('visionModelNone') }]

    for (const group of groups ?? []) {
      for (const model of group.models) {
        listed.push({
          value: `${group.id}/${model.id}`,
          label: model.name ?? model.id,
          group: group.name ?? group.id,
        })
      }
    }

    // A model configured earlier whose provider has since gone would otherwise
    // vanish from the dropdown and be silently replaced on the next save.
    if (props.value !== '' && !listed.some((option) => option.value === props.value)) {
      listed.push({ value: props.value, label: props.value, group: t('visionModelUnavailable') })
    }

    return listed
  }, [groups, props.value, t])

  const hint = failed
    ? t('visionModelUnreadable')
    : groups === undefined
      ? t('visionModelLoading')
      : t('visionModelHint')

  return (
    <Row label={t('visionModel')} hint={hint}>
      <Select
        value={props.value}
        options={options}
        disabled={props.disabled || groups === undefined}
        onChange={props.onChange}
        width={260}
      />
    </Row>
  )
}

/** The allowlist, edited as text and committed only when it parses. */
function AllowListRow(props: {
  ids: number[]
  locked: boolean
  overridden: boolean
  t: (key: LocaleKey) => string
  onCommit: (ids: number[]) => void
  onReset: () => void
}) {
  const stored = useMemo(() => props.ids.join(', '), [props.ids])
  const [draft, setDraft] = useState(stored)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    setDraft(stored)
    setInvalid(false)
  }, [stored])

  const commit = () => {
    const parsed = parseIds(draft)
    if (!parsed) return setInvalid(true)
    setInvalid(false)
    if (parsed.join(',') !== props.ids.join(',')) props.onCommit(parsed)
  }

  return (
    <Row
      label={props.t('allowFrom')}
      hint={invalid ? props.t('allowFromInvalid') : props.t('allowFromHint')}
      overridden={props.overridden}
      overriddenLabel={props.t('overridden')}
      resetLabel={props.t('reset')}
      onReset={props.onReset}
    >
      <TextInput
        value={draft}
        onChange={setDraft}
        onCommit={commit}
        disabled={props.locked}
        invalid={invalid}
        width={240}
        placeholder="562660734, 12345678"
      />
    </Row>
  )
}

/** A text input that reports its value only once the user is done typing. */
function CommittedText(props: {
  value: string
  onCommit: (value: string) => void
  disabled?: boolean
  width?: number
}) {
  const [draft, setDraft] = useState(props.value)
  useEffect(() => setDraft(props.value), [props.value])

  return (
    <TextInput
      value={draft}
      onChange={setDraft}
      onCommit={() => {
        if (draft !== props.value) props.onCommit(draft)
      }}
      disabled={props.disabled ?? false}
      {...(props.width !== undefined ? { width: props.width } : {})}
    />
  )
}

/** Subscribe to the scope, re-rendering whenever the host document moves. */
function useSettingsSnapshot<T>(scope: SettingsScope<T>): SettingsSnapshot<T> {
  const [snapshot, setSnapshot] = useState(() => scope.getSnapshot())

  useEffect(() => {
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
  }, [scope])

  return snapshot
}

/**
 * Whether a field carries a user override. Presence in the raw user layer is
 * the test — an override whose value equals the composed default is still an
 * override, and comparing values could not see it.
 */
function isOverridden(user: unknown, field: string): boolean {
  if (typeof user !== 'object' || user === null) return false
  return Object.hasOwn(user as Record<string, unknown>, field)
}

/** Parse a comma-separated id list, or reject the whole thing. */
function parseIds(text: string): number[] | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return []

  const ids: number[] = []
  for (const part of trimmed.split(',')) {
    const id = Number(part.trim())
    if (!Number.isInteger(id) || id <= 0) return undefined
    ids.push(id)
  }
  return ids
}
