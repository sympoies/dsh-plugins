/**
 * The small set of controls this page is built from.
 *
 * Written from scratch rather than borrowed: the client bundle purity gate
 * forbids importing another plugin's card chrome as a value, so a plugin
 * shipped outside the harness repository owns its own controls. They are
 * deliberately plain, and they take their colours from the shell's theme
 * variables so the page follows light and dark without knowing which is on.
 */

import type { ReactNode } from 'react'

/**
 * Shell theme tokens, with fallbacks for a shell that does not define them.
 *
 * The split between the two groups is load-bearing, not decorative. A `label-`
 * token is a FOREGROUND colour: in the dark theme it resolves to something
 * near white, so painting a surface with one produces white-on-white. Fills
 * must come from `FILL`, which holds only tokens meant to be painted.
 */

/** Foreground colours. Safe for text and borders; never for a background. */
const TEXT = {
  primary: 'var(--dsw-alias-label-primary, currentColor)',
  secondary: 'var(--dsw-alias-label-secondary, #6b7280)',
  tertiary: 'var(--dsw-alias-label-tertiary, #9ca3af)',
} as const

/**
 * Surface colours. Safe to paint.
 *
 * `brand` is a trap worth naming: despite the word, the shell resolves it to a
 * NEUTRAL — `#0f1115` in the light theme and `#f9fafb` in the dark one. It is
 * the high-contrast-against-the-page colour, so it belongs on text and borders.
 * A switch turned on with it is a white slab in one theme and a black one in
 * the other, and reads as neither on nor a switch.
 *
 * `action` is the shell's actual blue, and the one a control that means "on"
 * wants. It stays blue in both themes, which is what makes the state legible
 * at a glance rather than by comparison.
 */
const FILL = {
  /** High contrast against the page. Near-black in light, near-white in dark. */
  brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
  /** The shell's own action blue, for a control that is switched on. */
  action: 'var(--dsw-alias-button-info-fill, #4176e6)',
  surface: 'var(--dsw-alias-bg-layer-1, transparent)',
  /** A neutral track: a border token reads as a faint fill in both themes. */
  neutral: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.45))',
} as const

const COLOR = {
  text: TEXT.primary,
  muted: TEXT.secondary,
  faint: TEXT.tertiary,
  border: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.28))',
  borderStrong: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.45))',
  surface: FILL.surface,
  accent: FILL.brand,
  danger: 'var(--dsw-alias-state-error-primary, #dc2626)',
  success: 'var(--dsw-alias-state-success-primary, #16a34a)',
  warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
} as const

/** A titled group of related settings. */
export function Section(props: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h3
        style={{
          margin: '0 0 12px',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: COLOR.faint,
        }}
      >
        {props.title}
      </h3>
      <div
        style={{
          border: `1px solid ${COLOR.border}`,
          borderRadius: 10,
          background: COLOR.surface,
          overflow: 'hidden',
        }}
      >
        {props.children}
      </div>
    </section>
  )
}

/** One labelled setting: its control, its explanation, and its override state. */
export function Row(props: {
  label: string
  hint?: string
  /** Marks the value as user-changed and offers a way back to the composed one. */
  overridden?: boolean
  onReset?: () => void
  resetLabel?: string
  overriddenLabel?: string
  children: ReactNode
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
        padding: '14px 16px',
        borderBottom: `1px solid ${COLOR.border}`,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLOR.text, fontSize: 14 }}>
          <span>{props.label}</span>
          {props.overridden ? (
            <span
              style={{
                fontSize: 11,
                padding: '1px 6px',
                borderRadius: 999,
                color: COLOR.accent,
                border: `1px solid ${COLOR.accent}`,
                opacity: 0.85,
              }}
            >
              {props.overriddenLabel ?? 'changed'}
            </span>
          ) : null}
          {props.overridden && props.onReset ? (
            <button type="button" onClick={props.onReset} style={linkButtonStyle}>
              {props.resetLabel ?? 'Reset'}
            </button>
          ) : null}
        </div>
        {props.hint ? (
          <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, color: COLOR.muted }}>
            {props.hint}
          </div>
        ) : null}
      </div>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {props.children}
      </div>
    </div>
  )
}

/** A single-line text input. */
export function TextInput(props: {
  value: string
  onChange: (value: string) => void
  onCommit?: () => void
  placeholder?: string
  disabled?: boolean
  type?: 'text' | 'password'
  width?: number
  invalid?: boolean
}) {
  return (
    <input
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder ?? ''}
      disabled={props.disabled ?? false}
      onChange={(event) => props.onChange(event.target.value)}
      onBlur={props.onCommit ?? (() => undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') props.onCommit?.()
      }}
      style={{
        width: props.width ?? 220,
        padding: '6px 10px',
        fontSize: 13,
        color: COLOR.text,
        background: 'transparent',
        border: `1px solid ${props.invalid ? COLOR.danger : COLOR.borderStrong}`,
        borderRadius: 6,
        outline: 'none',
        opacity: props.disabled ? 0.5 : 1,
      }}
    />
  )
}

/** A numeric input that only reports whole, finite values. */
export function NumberInput(props: {
  value: number
  onCommit: (value: number) => void
  disabled?: boolean
  min?: number
}) {
  return (
    <input
      type="number"
      defaultValue={String(props.value)}
      disabled={props.disabled ?? false}
      min={props.min ?? 0}
      key={props.value}
      onBlur={(event) => {
        const next = Number(event.target.value)
        if (Number.isFinite(next) && Number.isInteger(next) && next >= (props.min ?? 0)) {
          if (next !== props.value) props.onCommit(next)
        }
      }}
      style={{
        width: 110,
        padding: '6px 10px',
        fontSize: 13,
        color: COLOR.text,
        background: 'transparent',
        border: `1px solid ${COLOR.borderStrong}`,
        borderRadius: 6,
        outline: 'none',
        opacity: props.disabled ? 0.5 : 1,
      }}
    />
  )
}

/**
 * An on/off switch.
 *
 * The track always carries a real fill — brand when on, neutral when off — and
 * the knob always carries an edge. Both matter: a transparent track leaves the
 * knob floating over the page background, and a knob with no edge disappears
 * into a pale track. Neither can be seen while testing one theme.
 */
export function Toggle(props: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled ?? false}
      onClick={() => props.onChange(!props.checked)}
      style={{
        boxSizing: 'border-box',
        // border-box plus these numbers leaves a 34x16 content box, so the
        // knob's travel below is exactly its width.
        width: 40,
        height: 22,
        padding: 2,
        // Never transparent: a track whose colour happens to match the page
        // would otherwise stop reading as a control at all. Off keeps a visible
        // edge; on, the fill already carries the shape.
        border: `1px solid ${props.checked ? 'transparent' : COLOR.border}`,
        borderRadius: 999,
        // Blue rather than the brand neutral: "on" should be a colour, not a
        // shade that inverts with the theme and reads as neither state.
        background: props.checked ? FILL.action : FILL.neutral,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        transition: 'background 120ms ease',
      }}
    >
      <span
        style={{
          display: 'block',
          width: 16,
          height: 16,
          borderRadius: '50%',
          // White on both tracks now: the blue is dark enough in either theme
          // for a white knob to carry the contrast, which is also the shape
          // every other switch anyone has used has.
          background: '#fff',
          border: '1px solid rgba(0, 0, 0, 0.12)',
          boxSizing: 'border-box',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.2)',
          transform: props.checked ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform 120ms ease',
        }}
      />
    </button>
  )
}

/** One choice in a {@link Select}, optionally grouped under a heading. */
export interface SelectOption {
  readonly value: string
  readonly label: string
  /** Groups options under a shared heading; ungrouped options come first. */
  readonly group?: string
}

/** A dropdown over a known set of choices. */
export function Select(props: {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  width?: number
}) {
  const groups = [...new Set(props.options.map((option) => option.group ?? ''))]

  return (
    <select
      value={props.value}
      disabled={props.disabled ?? false}
      onChange={(event) => props.onChange(event.target.value)}
      style={{
        width: props.width ?? 240,
        padding: '6px 8px',
        fontSize: 13,
        color: COLOR.text,
        // A transparent select shows the page through its own popup on some
        // platforms; a real surface keeps it readable in both themes.
        background: FILL.surface,
        border: `1px solid ${COLOR.borderStrong}`,
        borderRadius: 6,
        outline: 'none',
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      {groups.map((group) => {
        const members = props.options.filter((option) => (option.group ?? '') === group)
        const items = members.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))
        return group === '' ? (
          items
        ) : (
          <optgroup key={group} label={group}>
            {items}
          </optgroup>
        )
      })}
    </select>
  )
}

/** A push button for an action that is not a preference. */
export function Button(props: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled ?? false}
      style={{
        padding: '6px 12px',
        fontSize: 13,
        color: props.tone === 'danger' ? COLOR.danger : COLOR.text,
        background: 'transparent',
        border: `1px solid ${props.tone === 'danger' ? COLOR.danger : COLOR.borderStrong}`,
        borderRadius: 6,
        cursor: props.disabled ? 'default' : 'pointer',
        opacity: props.disabled ? 0.45 : 1,
      }}
    >
      {props.children}
    </button>
  )
}

/** A short status line: a fact about the world rather than a setting. */
export function Note(props: { tone: 'info' | 'good' | 'warn' | 'bad'; children: ReactNode }) {
  const color =
    props.tone === 'good'
      ? COLOR.success
      : props.tone === 'warn'
        ? COLOR.warn
        : props.tone === 'bad'
          ? COLOR.danger
          : COLOR.muted

  return <div style={{ fontSize: 12, lineHeight: 1.6, color }}>{props.children}</div>
}

export { COLOR, FILL, TEXT }

/** Shared style for the inline reset affordance. */
const linkButtonStyle = {
  padding: 0,
  fontSize: 11,
  color: COLOR.muted,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'underline',
} as const
