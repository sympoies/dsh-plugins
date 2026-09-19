import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { FILL, Select, TEXT, Toggle } from '../src/client/fields.js'
import { presentToken } from '../src/client/panel.js'

/**
 * A React element is a plain object, so a component's rendered style can be
 * read by calling it — no DOM, no renderer. That is enough to catch the class
 * of bug these tests exist for: a control that looks right in one theme and
 * disappears in the other.
 */
function styleOf(element: unknown): Record<string, unknown> {
  return (element as { props: { style: Record<string, unknown> } }).props.style
}

/** The knob is the switch's only child. */
function knobStyle(element: unknown): Record<string, unknown> {
  const children = (element as { props: { children: unknown } }).props.children
  return styleOf(children)
}

describe('Toggle — the track', () => {
  it('paints the action colour when on, not a theme-inverting shade', () => {
    // `brand` is a NEUTRAL despite the name — near-black in the light theme,
    // near-white in the dark one — so a switch turned on with it is a white
    // slab in one theme and a black one in the other.
    const track = styleOf(Toggle({ checked: true, onChange: () => undefined }))
    expect(track.background).toBe(FILL.action)
    expect(track.background).not.toBe(FILL.brand)
  })

  it('paints a real fill when off, so the knob never floats on the page', () => {
    const track = styleOf(Toggle({ checked: false, onChange: () => undefined }))
    expect(track.background).toBe(FILL.neutral)
  })

  it('looks different on than off', () => {
    const on = styleOf(Toggle({ checked: true, onChange: () => undefined }))
    const off = styleOf(Toggle({ checked: false, onChange: () => undefined }))
    expect(on.background).not.toBe(off.background)
  })

  it('never paints itself with a foreground token', () => {
    // A `label-` token is near-white in the dark theme: the exact bug this
    // guards. On plus a white knob produced a blank white pill.
    for (const checked of [true, false]) {
      const track = styleOf(Toggle({ checked, onChange: () => undefined }))
      expect(String(track.background)).not.toContain('label-')
    }
  })

  it('measures its own box, so the knob travel is exact', () => {
    const track = styleOf(Toggle({ checked: true, onChange: () => undefined }))
    expect(track.boxSizing).toBe('border-box')

    const width = Number(track.width)
    const padding = Number(track.padding)
    // border-box counts the border too, so the content box is narrower still.
    const border = Number(String(track.border).replace(/[^0-9.].*$/, ''))
    const content = width - border * 2 - padding * 2

    const knob = knobStyle(Toggle({ checked: true, onChange: () => undefined }))
    const travel = Number(String(knob.transform).replace(/[^0-9.-]/g, ''))

    // Content box width minus knob width: the knob lands flush at both ends.
    expect(travel).toBe(content - Number(knob.width))
  })
})

describe('Toggle — the knob', () => {
  it('carries an edge, so it stays visible on a pale track', () => {
    const knob = knobStyle(Toggle({ checked: true, onChange: () => undefined }))
    expect(knob.border).toBeTruthy()
  })

  it('sits at the start when off and travels when on', () => {
    const off = knobStyle(Toggle({ checked: false, onChange: () => undefined }))
    const on = knobStyle(Toggle({ checked: true, onChange: () => undefined }))
    expect(off.transform).toBe('translateX(0)')
    expect(on.transform).not.toBe('translateX(0)')
  })

  it('keeps its edge inside its own box, so it is not oversized', () => {
    const knob = knobStyle(Toggle({ checked: true, onChange: () => undefined }))
    expect(knob.boxSizing).toBe('border-box')
  })
})

describe('Toggle — accessibility', () => {
  it('reports its state to assistive technology', () => {
    const element = Toggle({ checked: true, onChange: () => undefined }) as {
      props: Record<string, unknown>
    }
    expect(element.props.role).toBe('switch')
    expect(element.props['aria-checked']).toBe(true)
  })
})

describe('theme tokens', () => {
  it('keeps foreground and fill tokens apart', () => {
    for (const token of Object.values(TEXT)) expect(token).toContain('label-')
    for (const token of Object.values(FILL)) expect(token).not.toContain('label-')
  })

  it('paints no surface anywhere in the page with a foreground token', async () => {
    // The whole class of bug, caught across every control at once.
    const sources = await Promise.all(
      ['src/client/fields.tsx', 'src/client/panel.tsx'].map((file) => readFile(file, 'utf8')),
    )

    for (const source of sources) {
      for (const match of source.matchAll(/background(?:Color)?:\s*([^\n,]+)/g)) {
        expect(match[1], `background bound to a foreground token: ${match[1]}`).not.toContain(
          'label-',
        )
      }
    }
  })

  it('gives every token a fallback, for a shell that defines none', () => {
    for (const token of [...Object.values(TEXT), ...Object.values(FILL)]) {
      expect(token, token).toMatch(/^var\(--dsw-[a-z0-9-]+,\s*.+\)$/)
    }
  })
})

describe('presentToken', () => {
  it('says it is checking before the host has answered', () => {
    const view = presentToken({ kind: 'checking' }, false)
    expect(view.hint).toBe('tokenChecking')
    expect(view.editable).toBe(false)
  })

  it('reports a failed check as a failed check, not as a cause it invented', () => {
    // The original bug: a describe whose answer was read wrongly produced
    // "supplied by the environment" — a confident, false explanation.
    const view = presentToken({ kind: 'unknown', reason: 'wire closed' }, false)
    expect(view.hint).toBe('tokenCheckFailed')
    expect(view.params).toEqual({ reason: 'wire closed' })
    expect(view.retryable).toBe(true)
  })

  it('offers a way to check again after a failure', () => {
    expect(presentToken({ kind: 'unknown', reason: 'x' }, false).retryable).toBe(true)
  })

  it('names the environment only when the host says the value comes from it', () => {
    const view = presentToken(
      { kind: 'known', configured: true, writable: false, source: 'env' },
      false,
    )
    expect(view.hint).toBe('tokenFromEnvironment')
    expect(view.editable).toBe(false)
  })

  it('says read-only, without guessing why, for any other unwritable source', () => {
    const view = presentToken({ kind: 'known', configured: true, writable: false }, false)
    expect(view.hint).toBe('tokenReadOnly')
  })

  it('lets a stored, writable token be replaced or removed', () => {
    const view = presentToken(
      { kind: 'known', configured: true, writable: true, source: 'file' },
      false,
    )
    expect(view.hint).toBe('tokenConfigured')
    expect(view.editable).toBe(true)
    expect(view.removable).toBe(true)
  })

  it('invites a first token when none is stored', () => {
    const view = presentToken({ kind: 'known', configured: false, writable: true }, false)
    expect(view.hint).toBe('tokenMissing')
    expect(view.editable).toBe(true)
    expect(view.removable).toBe(false)
  })

  it('offers no edit while the settings document itself is locked', () => {
    const view = presentToken({ kind: 'known', configured: true, writable: true }, true)
    expect(view.editable).toBe(false)
    expect(view.removable).toBe(false)
  })

  it('never claims the environment supplies a token it could not check', () => {
    for (const state of [
      { kind: 'checking' } as const,
      { kind: 'unknown', reason: 'boom' } as const,
    ]) {
      expect(presentToken(state, false).hint).not.toBe('tokenFromEnvironment')
    }
  })
})

describe('Select', () => {
  const options = [
    { value: '', label: 'None' },
    { value: 'a/1', label: 'One', group: 'Provider A' },
    { value: 'a/2', label: 'Two', group: 'Provider A' },
    { value: 'b/1', label: 'Three', group: 'Provider B' },
  ]

  /** The select's children, flattened past any optgroup wrappers. */
  function structure(element: unknown) {
    const children = (element as { props: { children: unknown[] } }).props.children
    return children.flat().map((child) => {
      const node = child as { type: unknown; props: { label?: string; children?: unknown } }
      return typeof node.type === 'string' && node.type === 'optgroup'
        ? { group: node.props.label }
        : { option: (node.props as { value?: string }).value }
    })
  }

  it('renders ungrouped options before any group', () => {
    const rendered = structure(Select({ value: '', options, onChange: () => undefined }))
    expect(rendered[0]).toEqual({ option: '' })
  })

  it('groups the rest under their provider', () => {
    const rendered = structure(Select({ value: '', options, onChange: () => undefined }))
    expect(rendered).toContainEqual({ group: 'Provider A' })
    expect(rendered).toContainEqual({ group: 'Provider B' })
  })

  it('shows the current value as selected', () => {
    const element = Select({ value: 'a/2', options, onChange: () => undefined }) as {
      props: { value: string }
    }
    expect(element.props.value).toBe('a/2')
  })

  it('paints a real surface, so its popup is readable in both themes', () => {
    const element = Select({ value: '', options, onChange: () => undefined }) as {
      props: { style: Record<string, unknown> }
    }
    expect(String(element.props.style.background)).not.toContain('label-')
    expect(element.props.style.background).toBe(FILL.surface)
  })

  it('can be disabled', () => {
    const element = Select({ value: '', options, onChange: () => undefined, disabled: true }) as {
      props: { disabled: boolean }
    }
    expect(element.props.disabled).toBe(true)
  })
})
