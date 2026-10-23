/**
 * Behaviour tests for dsh-ui-beautify/client.js.
 *
 * client.js is a browser classic script: it calls window.__ModuleLoader__.load
 * once and keeps everything inside the factory. This harness runs the file in a
 * node:vm context with a minimal DOM, storage, and module-loader stub. It is
 * test-only: the shipped plugin never evaluates code at runtime.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(projectRoot, 'client.js'), 'utf8')

/* ---------------------------------------------------------------------- *
 * Harness
 * ---------------------------------------------------------------------- */

function createStyleDeclaration() {
  const values = new Map()
  return {
    values,
    setProperty(name, value) {
      values.set(name, String(value))
    },
    getPropertyValue(name) {
      return values.has(name) ? values.get(name) : ''
    },
    removeProperty(name) {
      values.delete(name)
    },
  }
}

function createDocument() {
  const attributes = new Map()
  const styleTags = []

  const documentElement = {
    style: createStyleDeclaration(),
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    hasAttribute: (name) => attributes.has(name),
  }

  function createStyleNode() {
    return {
      tagName: 'style',
      dataset: {},
      textContent: '',
      remove() {
        const index = styleTags.indexOf(this)
        if (index >= 0) styleTags.splice(index, 1)
      },
    }
  }

  return {
    attributes,
    styleTags,
    documentElement,
    head: { append: (node) => styleTags.push(node) },
    body: { hasAttribute: () => false },
    createElement(tagName) {
      if (tagName === 'style') return createStyleNode()
      if (tagName === 'canvas') {
        return {
          tagName,
          width: 0,
          height: 0,
          getContext: () => ({ clearRect() {}, drawImage() {} }),
          toDataURL: () => 'data:image/webp;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          toBlob: (callback, type) => {
            setTimeout(
              () => callback(new Blob([new Uint8Array(64)], { type: type || 'image/webp' })),
              0,
            )
          },
        }
      }
      return { tagName, dataset: {}, textContent: '' }
    },
    querySelector(selector) {
      const match = /^style\[data-plugin-css="([^"]+)"\]$/.exec(selector)
      if (!match) return null
      return styleTags.find((tag) => tag.dataset.pluginCss === match[1]) ?? null
    },
  }
}

class FakeFileReader {
  readAsDataURL(file) {
    setTimeout(() => {
      this.result = file.dataUrl
      if (file.failRead) this.onerror?.(new Error('read failed'))
      else this.onload?.()
    }, 0)
  }
}

class FakeImage {
  constructor() {
    this.naturalWidth = 0
    this.naturalHeight = 0
    this.width = 0
    this.height = 0
  }

  set src(value) {
    this._src = value
    setTimeout(() => {
      const text = String(value)
      if (text.includes('badbad')) {
        this.onerror?.(new Error('decode failed'))
        return
      }
      if (text.includes('hugehuge')) {
        this.naturalWidth = 6000
        this.naturalHeight = 4000
      } else {
        this.naturalWidth = 800
        this.naturalHeight = 600
      }
      this.onload?.()
    }, 0)
  }

  get src() {
    return this._src
  }
}

function createStorage(initial = {}, { failing = false } = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem(key) {
      if (failing) throw new Error('storage disabled')
      return data.has(key) ? data.get(key) : null
    },
    setItem(key, value) {
      if (failing) throw new Error('storage disabled')
      data.set(key, String(value))
    },
    removeItem(key) {
      if (failing) throw new Error('storage disabled')
      data.delete(key)
    },
  }
}

function createFakeIndexedDB() {
  return {
    open() {
      const request = {}
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            throw new Error('transaction is not used by this test')
          },
        }
        request.onsuccess?.()
      }, 0)
      return request
    },
  }
}

class TestURL extends URL {}
TestURL.createObjectURL = (blob) => blob.__url || 'blob:test'
TestURL.revokeObjectURL = () => {}

function createReact() {
  return {
    createElement: (type, props, ...children) => {
      const next = props ? { ...props } : {}
      if (children.length === 1) next.children = children[0]
      else if (children.length > 1) next.children = children
      return { type, props: next, children }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
}

function loadClient({ storage, indexedDB: fakeIndexedDB, URLImpl } = {}) {
  const document = createDocument()
  const react = createReact()
  const registrations = []

  const window = {
    __ModuleLoader__: {
      load: (registration) => registrations.push(registration),
    },
    localStorage: storage ?? createStorage(),
  }

  const context = vm.createContext({
    window,
    document,
    console,
    URL: URLImpl ?? URL,
    FileReader: FakeFileReader,
    Image: FakeImage,
    Blob,
    ...(fakeIndexedDB ? { indexedDB: fakeIndexedDB } : {}),
    require: (id) => {
      if (id !== 'react') throw new Error(`unexpected platform module: ${id}`)
      return react
    },
  })

  vm.runInContext(source, context, { filename: 'client.js' })

  return { document, react, window, registrations, context }
}

function createCtx(harness) {
  const effects = []
  const registrations = []
  const tokenLayers = []
  const localeDicts = []

  const theme = {
    overrideTokens(source, tokens) {
      tokenLayers.push({ source, tokens, state: 'active' })
      return () => {
        tokenLayers.push({ source, tokens: null, state: 'removed' })
      }
    },
  }

  const ctx = {
    theme,
    effects,
    registrations,
    tokenLayers,
    localeDicts,
    effect(fn, label) {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
    locale: {
      register(ns, dicts) {
        localeDicts.push({ ns, dicts })
        return () => {}
      },
      bind() {
        return (key) => key
      },
    },
    slots: {
      inject(name, callback) {
        return callback(name)
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    get(name) {
      return name === 'theme' ? theme : undefined
    },
  }

  return ctx
}

function instantiate({ storage, indexedDB, URLImpl } = {}) {
  const harness = loadClient({ storage, indexedDB, URLImpl })
  assert.equal(harness.registrations.length, 1, 'exactly one module registration')

  const registration = harness.registrations[0]
  const plugin = registration.factory((id) => {
    if (id !== 'react') throw new Error(`unexpected platform module: ${id}`)
    return harness.react
  })

  return { ...harness, registration, plugin, ctx: createCtx(harness) }
}

function disposeAll(ctx) {
  for (const effect of [...ctx.effects].reverse()) {
    if (typeof effect.dispose === 'function') effect.dispose()
  }
}

/* ---------------------------------------------------------------------- *
 * Registration
 * ---------------------------------------------------------------------- */

test('registers under the package name', () => {
  const { registrations } = loadClient()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-ui-beautify')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('declares theme, slots, and locale dependencies', () => {
  const { plugin } = instantiate()
  assert.deepEqual([...plugin.inject], ['slots', 'locale', 'theme'])
  assert.equal(typeof plugin.apply, 'function')
})

test('registers one settings.section entry', () => {
  const { plugin, ctx } = instantiate()
  plugin.apply(ctx)

  assert.equal(ctx.registrations.length, 1)
  const entry = ctx.registrations[0]
  assert.equal(entry.options.name, 'settings.section')
  assert.equal(entry.options.id, 'dsh-ui-beautify')
  assert.equal(entry.options.order, 38)
  assert.equal(entry.options.locale, 'dshUiBeautify')
  assert.equal(entry.options.label(), 'nav')
  assert.equal(typeof entry.component, 'function')
})

test('registers zh and en dictionaries', () => {
  const { plugin, ctx } = instantiate()
  plugin.apply(ctx)

  assert.equal(ctx.localeDicts.length, 1)
  assert.equal(ctx.localeDicts[0].ns, 'dshUiBeautify')
  assert.equal(ctx.localeDicts[0].dicts.zh.nav, '界面美化')
  assert.equal(ctx.localeDicts[0].dicts.en.nav, 'UI beautify')
})

/* ---------------------------------------------------------------------- *
 * Settings normalization and token construction
 * ---------------------------------------------------------------------- */

test('normalizes settings with defaults and clamps', () => {
  const { plugin } = instantiate()
  const { normalizeSettings, DEFAULT_SETTINGS } = plugin.__test

  const defaults = normalizeSettings(null)
  assert.equal(defaults.style, DEFAULT_SETTINGS.style)
  assert.equal(defaults.surfaceOpacity, 100)
  assert.equal(defaults.wallpaperBlur, 0)
  assert.equal(defaults.wallpaperDim, 0)
  assert.equal(defaults.fontText, 'follow')
  assert.equal(defaults.fontCode, 'follow')

  const clamped = normalizeSettings({
    style: 'neon',
    surfaceOpacity: 999,
    wallpaperBlur: -3,
    wallpaperDim: 200,
    fontText: 'x',
    fontCode: 'y',
  })
  assert.equal(clamped.style, 'follow')
  assert.equal(clamped.surfaceOpacity, 100)
  assert.equal(clamped.wallpaperBlur, 0)
  assert.equal(clamped.wallpaperDim, 70)
  assert.equal(clamped.fontText, 'follow')
  assert.equal(clamped.fontCode, 'follow')

  assert.equal(normalizeSettings({ surfaceOpacity: '50' }).surfaceOpacity, 50)
  assert.equal(normalizeSettings({ customTextFont: 123 }).customTextFont, '')
})

test('converts hex colors to rgba', () => {
  const { plugin } = instantiate()
  const { rgbaFromHex } = plugin.__test

  assert.equal(rgbaFromHex('#ffffff', 50), 'rgba(255, 255, 255, 0.5)')
  assert.equal(rgbaFromHex('#00000080', 50), 'rgba(0, 0, 0, 0.251)')
  assert.equal(rgbaFromHex('#000', 100), 'rgba(0, 0, 0, 1)')
  assert.equal(rgbaFromHex('#abc', 50), 'rgba(170, 187, 204, 0.5)')
  assert.equal(rgbaFromHex('not-a-color', 50), 'not-a-color')
})

test('default settings produce no token layer', () => {
  const { plugin, ctx, document } = instantiate()
  plugin.apply(ctx)

  assert.equal(ctx.tokenLayers.length, 0)
  assert.equal(document.documentElement.getAttribute('data-dsh-ui-beautify'), 'on')
  assert.equal(document.styleTags.length, 1)
  assert.equal(document.styleTags[0].dataset.plugin, 'dsh-ui-beautify')
})

test('a style preset carries light and dark token pairs', () => {
  const { plugin } = instantiate()
  const { buildTokens, DEFAULT_SETTINGS } = plugin.__test

  const tokens = buildTokens({ ...DEFAULT_SETTINGS, style: 'glass', surfaceOpacity: 50 })

  assert.equal(tokens['--dsw-alias-bg-base'].light, 'rgba(255, 255, 255, 0.5)')
  assert.equal(tokens['--dsw-alias-bg-base'].dark, 'rgba(15, 18, 24, 0.5)')
  assert.equal(tokens['--dsw-alias-bg-overlay'].light, 'rgba(251, 253, 255, 0.88)')
  assert.equal(tokens['--dsw-alias-border-l1'].light, '#e3eaf3')
  assert.equal(tokens['--dsw-alias-label-primary'].dark, '#eef3fa')
  assert.equal(tokens['--dsw-radius-panel'].light, '30px')
  assert.equal(tokens['--dsh-font-family-text'], undefined)
})

test('follow + opacity only overrides surfaces', () => {
  const { plugin } = instantiate()
  const { buildTokens, DEFAULT_SETTINGS } = plugin.__test

  const tokens = buildTokens({ ...DEFAULT_SETTINGS, surfaceOpacity: 40 })

  assert.equal(tokens['--dsw-alias-bg-base'].light, 'rgba(255, 255, 255, 0.4)')
  assert.equal(tokens['--dsw-alias-bg-base'].dark, 'rgba(21, 21, 23, 0.4)')
  assert.equal(tokens['--dsw-alias-bg-overlay'].light, 'rgba(255, 255, 255, 0.88)')
  assert.equal(tokens['--dsw-alias-border-l1'], undefined)
  assert.equal(tokens['--dsw-alias-label-primary'], undefined)
})

test('font presets and custom names become token pairs', () => {
  const { plugin } = instantiate()
  const { buildTokens, normalizeFontList, DEFAULT_SETTINGS, FONT_TEXT_PRESETS } = plugin.__test

  assert.equal(normalizeFontList('sans-serif'), 'sans-serif')
  assert.equal(normalizeFontList('  A , B '), '"A", "B"')
  assert.equal(normalizeFontList('bad; font{'), '"bad font"')
  assert.equal(normalizeFontList(''), '')

  const serif = buildTokens({ ...DEFAULT_SETTINGS, fontText: 'serif' })
  assert.equal(serif['--dsh-font-family-text'].light, FONT_TEXT_PRESETS.serif)
  assert.equal(serif['--dsh-font-family-text'].dark, FONT_TEXT_PRESETS.serif)
  assert.equal(serif['--dsw-alias-bg-base'], undefined)

  const custom = buildTokens({
    ...DEFAULT_SETTINGS,
    fontText: 'custom',
    customTextFont: 'My Font, sans-serif',
  })
  assert.equal(custom['--dsh-font-family-text'].light, '"My Font", sans-serif')
})

/* ---------------------------------------------------------------------- *
 * Wallpaper validation and CSS
 * ---------------------------------------------------------------------- */

test('rejects unsafe wallpaper sources', () => {
  const { plugin } = instantiate()
  const { sanitizeImageUrl, isSafeDataImage, normalizeWallpaper } = plugin.__test

  assert.equal(sanitizeImageUrl('javascript:alert(1)'), null)
  assert.equal(sanitizeImageUrl('file:///c:/x.png'), null)
  assert.equal(sanitizeImageUrl('https://user:pass@example.com/x.png'), null)
  assert.equal(sanitizeImageUrl('https://example.com/x.png'), 'https://example.com/x.png')

  assert.equal(isSafeDataImage('data:image/png;base64,AAAA'), true)
  assert.equal(isSafeDataImage('data:image/jpeg;base64,AAAA'), true)
  assert.equal(isSafeDataImage('data:image/svg+xml;base64,AAAA'), false)
  assert.equal(isSafeDataImage('data:text/html;base64,AAAA'), false)
  assert.equal(isSafeDataImage(''), false)

  assert.equal(normalizeWallpaper({ kind: 'url', value: 'javascript:alert(1)' }), null)
  assert.equal(normalizeWallpaper({ kind: 'data', value: 'data:image/svg+xml;base64,AAAA' }), null)
  assert.equal(normalizeWallpaper(null), null)
})

test('normalizes wallpaper metadata', () => {
  const { plugin } = instantiate()
  const { normalizeWallpaper } = plugin.__test

  const data = normalizeWallpaper({
    kind: 'data',
    value: 'data:image/png;base64,AAAA',
    name: 'x.png',
    width: 10.6,
    height: 20.2,
    bytes: 33.3,
  })
  assert.equal(data.kind, 'data')
  assert.equal(data.name, 'x.png')
  assert.equal(data.width, 11)
  assert.equal(data.height, 20)
  assert.equal(data.bytes, 33)

  const url = normalizeWallpaper({ kind: 'url', value: 'https://example.com/x.png' })
  assert.equal(url.kind, 'url')
  assert.equal(url.name, 'https://example.com/x.png')
})

test('stores a small local image without compression', async () => {
  const { plugin } = instantiate()
  const result = await plugin.__test.prepareWallpaperFile({
    type: 'image/png',
    size: 100,
    name: 'x.png',
    dataUrl: 'data:image/png;base64,AAAA',
  })

  assert.equal(result.kind, 'data')
  assert.equal(result.width, 800)
  assert.equal(result.height, 600)
  assert.equal(result.name, 'x.png')
})

test('downscales an oversized local image', async () => {
  const { plugin } = instantiate()
  const result = await plugin.__test.prepareWallpaperFile({
    type: 'image/png',
    size: 100,
    name: 'big.png',
    dataUrl: 'data:image/png;base64,hugehuge',
  })

  assert.equal(result.kind, 'data')
  assert.equal(result.width, 2560)
  assert.equal(result.height, 1707)
  assert.equal(result.name, 'big.png')
})

test('rejects an undecodable local image', async () => {
  const { plugin } = instantiate()
  await assert.rejects(
    () =>
      plugin.__test.prepareWallpaperFile({
        type: 'image/png',
        size: 100,
        name: 'bad.png',
        dataUrl: 'data:image/png;base64,badbad',
      }),
    /decode-failed/,
  )
})

test('stores a small local image as an IndexedDB Blob', async () => {
  const { plugin } = instantiate({ indexedDB: createFakeIndexedDB(), URLImpl: TestURL })
  const file = { type: 'image/png', size: 100, name: 'small.png' }
  const result = await plugin.__test.prepareWallpaperFile(file)

  assert.equal(result.kind, 'blob')
  assert.equal(result.blob, file)
  assert.equal(result.width, 800)
  assert.equal(result.height, 600)
  assert.equal(result.name, 'small.png')
})

test('downscales an oversized image to an IndexedDB Blob', async () => {
  const { plugin } = instantiate({ indexedDB: createFakeIndexedDB(), URLImpl: TestURL })
  const result = await plugin.__test.prepareWallpaperFile({
    type: 'image/png',
    size: 100,
    name: 'big.png',
    __url: 'hugehuge',
  })

  assert.equal(result.kind, 'blob')
  assert.equal(result.width, 2560)
  assert.equal(result.height, 1707)
  assert.ok(result.blob)
})

test('builds wallpaper CSS with an escaped URL', () => {
  const { plugin } = instantiate()
  const { buildWallpaperCss, cssUrl } = plugin.__test

  const css = buildWallpaperCss('https://example.com/a.jpg')
  assert.match(css, /background-image: url\("https:\/\/example\.com\/a\.jpg"\)/)
  assert.match(css, /body::before/)
  assert.match(css, /body::after/)
  assert.match(css, /z-index: -2/)
  assert.match(css, /z-index: -1/)
  assert.match(css, /background-color: Canvas/)
  assert.ok(!css.includes('javascript:'))

  assert.equal(cssUrl('a"b'), 'url("a\\"b")')
})

test('formats byte sizes and truncates text', () => {
  const { plugin } = instantiate()
  const { formatBytes, truncateText } = plugin.__test

  assert.equal(formatBytes(0), '0 KB')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB')

  assert.equal(truncateText('abcdef', 4), 'abc…')
  assert.equal(truncateText('abc', 4), 'abc')
  assert.equal(truncateText(null, 4), '')
})

/* ---------------------------------------------------------------------- *
 * Apply and cleanup
 * ---------------------------------------------------------------------- */

test('applies a stored style and wallpaper', () => {
  const storage = createStorage({
    'dsh-ui-beautify:settings': JSON.stringify({
      style: 'glass',
      surfaceOpacity: 40,
      wallpaperBlur: 6,
      wallpaperDim: 20,
    }),
    'dsh-ui-beautify:wallpaper': JSON.stringify({
      kind: 'url',
      value: 'https://example.com/w.jpg',
      name: 'w.jpg',
    }),
  })
  const { plugin, ctx, document } = instantiate({ storage })
  plugin.apply(ctx)

  assert.equal(ctx.tokenLayers.length, 1)
  assert.equal(ctx.tokenLayers[0].source, 'dsh-ui-beautify')
  assert.equal(ctx.tokenLayers[0].tokens['--dsw-alias-bg-base'].light, 'rgba(255, 255, 255, 0.4)')

  assert.equal(document.documentElement.getAttribute('data-dsh-ui-beautify'), 'on')
  assert.equal(document.documentElement.getAttribute('data-dsh-ui-beautify-wallpaper'), 'on')
  assert.equal(
    document.documentElement.style.getPropertyValue('--dsh-ui-beautify-wallpaper-filter'),
    'blur(6px)',
  )
  assert.equal(
    document.documentElement.style.getPropertyValue('--dsh-ui-beautify-wallpaper-dim'),
    '0.2',
  )

  assert.equal(document.styleTags.length, 2)
  const wallpaperTag = document.styleTags.find(
    (tag) => tag.dataset.pluginCss === 'dsh-ui-beautify/wallpaper.css',
  )
  assert.ok(wallpaperTag)
  assert.ok(wallpaperTag.textContent.includes('background-image: url("https://example.com/w.jpg")'))
})

test('cleanup removes the token layer, attributes, variables, and tags', () => {
  const storage = createStorage({
    'dsh-ui-beautify:settings': JSON.stringify({ style: 'sakura', surfaceOpacity: 70 }),
    'dsh-ui-beautify:wallpaper': JSON.stringify({
      kind: 'url',
      value: 'https://example.com/w.jpg',
    }),
  })
  const { plugin, ctx, document } = instantiate({ storage })
  plugin.apply(ctx)
  disposeAll(ctx)

  assert.equal(ctx.tokenLayers.length, 2)
  assert.equal(ctx.tokenLayers[1].state, 'removed')
  assert.equal(document.documentElement.getAttribute('data-dsh-ui-beautify'), null)
  assert.equal(document.documentElement.getAttribute('data-dsh-ui-beautify-wallpaper'), null)
  assert.equal(
    document.documentElement.style.getPropertyValue('--dsh-ui-beautify-wallpaper-filter'),
    '',
  )
  assert.equal(document.styleTags.length, 0)
})

test('a throwing storage backend does not break apply', () => {
  const storage = createStorage({}, { failing: true })
  const { plugin, ctx, document } = instantiate({ storage })

  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.equal(document.documentElement.getAttribute('data-dsh-ui-beautify'), 'on')
  assert.equal(ctx.tokenLayers.length, 0)
})

test('settings changes re-apply the token layer, blur changes do not', async () => {
  const storage = createStorage({
    'dsh-ui-beautify:settings': JSON.stringify({ style: 'glass', surfaceOpacity: 90 }),
    'dsh-ui-beautify:wallpaper': JSON.stringify({
      kind: 'url',
      value: 'https://example.com/w.jpg',
    }),
  })
  const { plugin, ctx, document } = instantiate({ storage })
  plugin.apply(ctx)

  assert.equal(ctx.tokenLayers.length, 1)
  const runtime = plugin.__test.getRuntime()

  runtime.setSettings({ surfaceOpacity: 50 })
  assert.equal(ctx.tokenLayers.length, 2)
  assert.equal(ctx.tokenLayers[1].tokens['--dsw-alias-bg-base'].light, 'rgba(255, 255, 255, 0.5)')

  // Blur only changes a CSS variable; it must not rebuild the token layer.
  runtime.setSettings({ wallpaperBlur: 10 })
  assert.equal(ctx.tokenLayers.length, 2)
  assert.equal(
    document.documentElement.style.getPropertyValue('--dsh-ui-beautify-wallpaper-filter'),
    'blur(10px)',
  )

  // Removing the wallpaper clears the attributes and the dynamic stylesheet.
  await runtime.setWallpaper(null)
  assert.equal(document.documentElement.getAttribute('data-dsh-ui-beautify-wallpaper'), null)
  assert.equal(
    document.documentElement.style.getPropertyValue('--dsh-ui-beautify-wallpaper-filter'),
    '',
  )
  assert.equal(
    document.styleTags.filter((tag) => tag.dataset.pluginCss === 'dsh-ui-beautify/wallpaper.css')
      .length,
    0,
  )
})

/* ---------------------------------------------------------------------- *
 * Static safety
 * ---------------------------------------------------------------------- */

test('settings page CSS follows theme tokens', () => {
  const { plugin } = instantiate()
  const css = plugin.__test.STATIC_CSS

  assert.ok(css.includes('.dsh-ui-beautify-page'))
  assert.ok(css.includes('var(--dsw-alias-label-secondary'))
  assert.ok(css.includes('var(--dub-accent)'))
  assert.ok(css.includes('var(--dsw-alias-border-l2'))
})

test('the settings page component is exported for inspection', () => {
  const { plugin } = instantiate()
  assert.equal(typeof plugin.__test.SettingsPage, 'function')
})

test('renders the settings page tree with the expected controls', () => {
  const { plugin, ctx } = instantiate()
  plugin.apply(ctx)

  const page = plugin.__test.SettingsPage({ t: (key) => key })
  assert.equal(page.type, 'div')
  assert.equal(page.props.className, 'dsh-ui-beautify-page')

  const sections = page.children.filter(
    (child) => child && child.props && typeof child.props.title === 'string',
  )
  assert.equal(sections.length, 4)

  const styleSection = sections.find((section) => section.props.title === 'style.title')
  assert.ok(styleSection)
  const styleGrid = styleSection.props.children
  assert.equal(styleGrid.children.length, 5)
  assert.equal(styleGrid.children[0].props['aria-pressed'], 'true')
  assert.equal(typeof styleGrid.children[0].props.onClick, 'function')

  const surfaceSection = sections.find((section) => section.props.title === 'surface.title')
  assert.ok(surfaceSection)
  assert.equal(surfaceSection.props.children.length, 3)
  assert.equal(surfaceSection.props.children[0].props.title, 'surface.opacity')
  assert.equal(surfaceSection.props.children[0].props.value, 100)

  const wallpaperSection = sections.find((section) => section.props.title === 'wallpaper.title')
  assert.ok(wallpaperSection)
  const actions = wallpaperSection.props.children.find(
    (child) => child && child.props && child.props.className === 'dub-wallpaper-actions',
  )
  assert.ok(actions)
  const fileInput = actions.children.find(
    (child) => child && child.props && child.props.type === 'file',
  )
  assert.ok(fileInput)
  assert.equal(fileInput.props.accept, 'image/png,image/jpeg,image/webp,image/gif,image/avif')

  const fontSection = sections.find((section) => section.props.title === 'font.title')
  assert.ok(fontSection)
  assert.equal(fontSection.props.children.length, 2)
  assert.equal(fontSection.props.children[0].props.title, 'font.text')
  assert.equal(fontSection.props.children[1].props.title, 'font.code')

  const footer = page.children.find(
    (child) => child && child.props && child.props.className === 'dub-footer',
  )
  assert.ok(footer)
  assert.equal(footer.children[0].children[0], 'reset')
})

test('the plugin performs no network, eval, or HTML-injection work', () => {
  const forbidden = [
    /\beval\s*\(/,
    /new\s+Function\s*\(/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /\.innerHTML\s*=/,
    /document\.write\s*\(/,
    /localStorage\.clear\s*\(/,
  ]
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `forbidden pattern present: ${pattern}`)
  }
})
