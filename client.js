/**
 * dsh-ui-beautify — Web half.
 *
 * What it does
 *   - Lets the user pick an overall style preset (follow DSH / glass / warm
 *     paper / sakura / minimal), set surface opacity, add a wallpaper, and
 *     choose interface and code fonts.
 *   - Applies colors, radius, transparency, and font lists through the Client
 *     theme service (`ctx.theme.overrideTokens`). The theme service composes
 *     the layer over the active built-in theme and the DSH theme presenter
 *     writes the resulting tokens onto `body`; removing the layer restores
 *     the stock appearance.
 *   - Draws the wallpaper with two plugin-owned pseudo-elements on `body`
 *     (`::before` for the image, `::after` for the readability scrim). The
 *     DSH app tree is never replaced and no second app is mounted.
 *
 * Contract notes (checked against DSH 0.2.1-rc.2 on 2026-10-23)
 *   - This file is a classic script. The browser calls
 *     `window.__ModuleLoader__.load` exactly once; `id` equals the package
 *     name, and React comes from the browser module table.
 *   - `settings.section` is a list slot with `{ name, id, order, label,
 *     locale }`; the registered component receives standard slot props.
 *   - `ctx.theme.overrideTokens(source, tokens)` takes a token-name map to
 *     `{ light, dark }` string pairs. A bare string throws, so every value is
 *     a two-mode pair.
 *   - Plugin-owned global CSS lives in `<style data-plugin data-plugin-css>`
 *     elements and is removed on unload.
 *
 * Privacy
 *   - No network requests, no conversation reads, no Host calls, no logging
 *     of user content. Preferences live in this browser's localStorage. A
 *     remote wallpaper URL is fetched by the browser (as any CSS background
 *     image is), not by plugin JavaScript.
 */

window.__ModuleLoader__.load({
  id: 'dsh-ui-beautify',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const PLUGIN_ID = 'dsh-ui-beautify'
    const NS = 'dshUiBeautify'

    const SETTINGS_KEY = 'dsh-ui-beautify:settings'
    const WALLPAPER_KEY = 'dsh-ui-beautify:wallpaper'
    const ROOT_ATTR = 'data-dsh-ui-beautify'
    const WALLPAPER_ATTR = 'data-dsh-ui-beautify-wallpaper'
    const FILTER_VAR = '--dsh-ui-beautify-wallpaper-filter'
    const DIM_VAR = '--dsh-ui-beautify-wallpaper-dim'
    const STATIC_CSS_ID = 'dsh-ui-beautify/static.css'
    const WALLPAPER_CSS_ID = 'dsh-ui-beautify/wallpaper.css'
    const TOKEN_SOURCE = PLUGIN_ID

    /** Upper bound for one stored wallpaper data URL (characters, not bytes). */
    const WALLPAPER_MAX_CHARS = 1800000
    /** Upper bound for the file the user picks before compression. */
    const WALLPAPER_MAX_FILE_BYTES = 16 * 1024 * 1024
    /** Longest edge kept after image compression. */
    const WALLPAPER_MAX_EDGE = 2560
    /** Successive downscale/quality attempts, largest first. */
    const WALLPAPER_ATTEMPTS = [
      { scale: 1, quality: 0.82 },
      { scale: 0.85, quality: 0.72 },
      { scale: 0.7, quality: 0.62 },
      { scale: 0.55, quality: 0.52 },
    ]

    const STYLE_IDS = ['follow', 'glass', 'paper', 'sakura', 'minimal']
    const FONT_TEXT_IDS = ['follow', 'sans', 'serif', 'rounded', 'mono', 'custom']
    const FONT_CODE_IDS = ['follow', 'mono', 'sans', 'custom']

    const DEFAULT_SETTINGS = Object.freeze({
      style: 'follow',
      surfaceOpacity: 100,
      wallpaperBlur: 0,
      wallpaperDim: 0,
      fontText: 'follow',
      customTextFont: '',
      fontCode: 'follow',
      customCodeFont: '',
    })

    /* ------------------------------------------------------------------ *
     * Dictionaries
     * ------------------------------------------------------------------ */

    const DICT = {
      zh: {
        nav: '界面美化',
        title: '界面美化',
        subtitle: '调整整体配色、表面透明度、背景图与字体。所有设置只保存在本机浏览器。',
        'style.title': '外观风格',
        'style.desc': '选择一套整体观感；每套都同时定义明亮与深色两组取值。',
        'style.follow': '跟随 DSH',
        'style.follow.desc': '不改变 DSH 原有配色，只叠加透明度和字体设置。',
        'style.glass': '玻璃',
        'style.glass.desc': '冷调半透明表面、较大的圆角，适合搭配背景图。',
        'style.paper': '暖纸',
        'style.paper.desc': '暖白/暖黑底色、细边框与较柔和的对比。',
        'style.sakura': '樱花',
        'style.sakura.desc': '淡粉色调、较大的圆角，明亮模式下观感最明显。',
        'style.minimal': '极简',
        'style.minimal.desc': '中性灰阶、小圆角、弱化装饰。',
        'surface.title': '透明度与材质',
        'surface.desc': '透明度越低，背景图越明显；过低会影响文字可读性。',
        'surface.opacity': '表面透明度',
        'surface.opacityHint': '0% 完全透明，100% 不透明',
        'surface.blur': '背景模糊',
        'surface.dim': '背景遮罩',
        'surface.dimHint': '在背景图上加一层浅色/深色遮罩，提升文字可读性',
        'wallpaper.title': '背景图',
        'wallpaper.desc': '支持本地上传或图片链接。本地图片会在浏览器内压缩后保存，不会上传。',
        'wallpaper.upload': '选择本地图片',
        'wallpaper.uploading': '正在处理…',
        'wallpaper.url': '图片链接',
        'wallpaper.urlPlaceholder': 'https://example.com/wallpaper.jpg',
        'wallpaper.applyUrl': '使用链接',
        'wallpaper.clear': '清除背景图',
        'wallpaper.cleared': '已清除背景图。',
        'wallpaper.none': '当前没有背景图。',
        'wallpaper.local': '本地图片',
        'wallpaper.remote': '网络图片',
        'wallpaper.saved': '背景图已保存到本机浏览器。',
        'wallpaper.notPersisted': '背景图已应用，但浏览器存储空间不足，刷新后会丢失。请换一张更小的图片或使用图片链接。',
        'wallpaper.tooLarge': '图片太大，压缩后仍超过本地存储上限。请换一张，或改用图片链接。',
        'wallpaper.unsupported': '不支持这个文件类型。请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片。',
        'wallpaper.readFailed': '读取图片失败，请重试。',
        'wallpaper.decodeFailed': '无法解析这张图片，请换一张。',
        'wallpaper.invalidUrl': '请输入 http 或 https 开头的图片链接。',
        'wallpaper.remoteHint': '使用链接时，浏览器会直接向该地址请求图片。',
        'wallpaper.visibleHint': '如果主界面看不到背景图，请把上方「表面透明度」调低（例如 60%）。',
        'font.title': '字体',
        'font.desc': '字体列表会优先于 DSH 自带字体；选择“跟随 DSH”则使用系统默认。',
        'font.text': '界面字体',
        'font.code': '代码字体',
        'font.follow': '跟随 DSH',
        'font.sans': '系统无衬线',
        'font.serif': '衬线 / 宋体',
        'font.rounded': '圆体',
        'font.mono': '等宽',
        'font.custom': '自定义…',
        'font.customLabel': '自定义字体名',
        'font.customPlaceholder': '例如：LXGW WenKai, Noto Serif SC',
        'font.customHint': '用逗号分隔多个字体名；本机没装的字体会自动回退。',
        reset: '恢复默认',
        'reset.confirm': '再次点击确认',
        'reset.hint': '再次点击将同时清除背景图并恢复 DSH 原始外观。',
        'reset.done': '已恢复默认外观。',
        privacy: '设置只保存在本机浏览器的 localStorage；插件不联网、不读取会话内容。',
      },
      en: {
        nav: 'UI beautify',
        title: 'UI beautify',
        subtitle: 'Adjust the overall palette, surface transparency, wallpaper, and fonts. Everything is stored in this browser.',
        'style.title': 'Style',
        'style.desc': 'Pick an overall look. Every style ships light and dark values.',
        'style.follow': 'Follow DSH',
        'style.follow.desc': 'Keep the DSH palette and only apply transparency and font choices.',
        'style.glass': 'Glass',
        'style.glass.desc': 'Cool translucent surfaces and larger corners; pairs well with a wallpaper.',
        'style.paper': 'Warm paper',
        'style.paper.desc': 'Warm light/dark tones, hairline borders, softer contrast.',
        'style.sakura': 'Sakura',
        'style.sakura.desc': 'Soft pink tones and larger corners; most visible in light mode.',
        'style.minimal': 'Minimal',
        'style.minimal.desc': 'Neutral grays, small corners, reduced decoration.',
        'surface.title': 'Transparency and material',
        'surface.desc': 'Lower opacity reveals more of the wallpaper. Very low values reduce text readability.',
        'surface.opacity': 'Surface opacity',
        'surface.opacityHint': '0% fully transparent, 100% opaque',
        'surface.blur': 'Wallpaper blur',
        'surface.dim': 'Wallpaper dim',
        'surface.dimHint': 'Adds a light/dark scrim over the wallpaper to improve readability',
        'wallpaper.title': 'Wallpaper',
        'wallpaper.desc': 'Choose a local image or paste an image URL. Local images are compressed in this browser and never uploaded.',
        'wallpaper.upload': 'Choose local image',
        'wallpaper.uploading': 'Processing…',
        'wallpaper.url': 'Image URL',
        'wallpaper.urlPlaceholder': 'https://example.com/wallpaper.jpg',
        'wallpaper.applyUrl': 'Use URL',
        'wallpaper.clear': 'Remove wallpaper',
        'wallpaper.cleared': 'Wallpaper removed.',
        'wallpaper.none': 'No wallpaper selected.',
        'wallpaper.local': 'Local image',
        'wallpaper.remote': 'Remote image',
        'wallpaper.saved': 'Wallpaper saved in this browser.',
        'wallpaper.notPersisted': 'Wallpaper applied for this session, but browser storage is full. Refresh will lose it; try a smaller image or an image URL.',
        'wallpaper.tooLarge': 'This image is still too large after compression. Try another image or use an image URL.',
        'wallpaper.unsupported': 'Unsupported file type. Choose a PNG, JPEG, WebP, GIF, or AVIF image.',
        'wallpaper.readFailed': 'Could not read the image. Please try again.',
        'wallpaper.decodeFailed': 'Could not decode this image. Try another one.',
        'wallpaper.invalidUrl': 'Enter an image URL that starts with https or http.',
        'wallpaper.remoteHint': 'With a URL, the browser requests the image directly from that address.',
        'wallpaper.visibleHint': 'If the wallpaper is not visible behind the UI, lower Surface opacity above (for example to 60%).',
        'font.title': 'Fonts',
        'font.desc': 'The chosen list takes precedence over the DSH font. Choose “Follow DSH” to use the system default.',
        'font.text': 'Interface font',
        'font.code': 'Code font',
        'font.follow': 'Follow DSH',
        'font.sans': 'System sans',
        'font.serif': 'Serif / Song',
        'font.rounded': 'Rounded',
        'font.mono': 'Monospace',
        'font.custom': 'Custom…',
        'font.customLabel': 'Custom font names',
        'font.customPlaceholder': 'e.g. LXGW WenKai, Noto Serif SC',
        'font.customHint': 'Separate names with commas. Missing fonts fall back automatically.',
        reset: 'Reset',
        'reset.confirm': 'Click again to confirm',
        'reset.hint': 'Click again to remove the wallpaper and restore the DSH appearance.',
        'reset.done': 'Restored the default appearance.',
        privacy: 'Settings stay in this browser’s localStorage. The plugin makes no network requests and reads no conversation content.',
      },
    }

    /* ------------------------------------------------------------------ *
     * Palettes
     *
     * Each style carries a full light and dark palette. Surface keys are
     * converted to rgba() with the user's opacity; text/border/accent keys
     * stay opaque so contrast survives a translucent background.
     * ------------------------------------------------------------------ */

    const STYLES = {
      follow: {
        palette: {
          light: {
            base: '#ffffff',
            layer1: '#ffffff',
            layer2: '#f5f6f8',
            overlay: '#ffffff',
            module: '#f2f3f5',
            sidebar: '#f7f8fa',
            bubble: '#e8f0fe',
            bubbleHighlight: '#dbe7fb',
            codeBlock: '#f3f5f8',
            borderL1: '#e8eaee',
            borderL2: '#dde0e5',
            borderL3: '#d2d5db',
            borderL4: '#c6cad2',
            labelPrimary: '#1a1c1f',
            labelSecondary: '#565a61',
            labelTertiary: '#8a8e96',
            brand: '#4176e6',
            hover: 'rgba(0, 0, 0, 0.05)',
            separator: '#e8eaee',
          },
          dark: {
            base: '#151517',
            layer1: '#1c1c1f',
            layer2: '#232326',
            overlay: '#1f1f22',
            module: '#1b1b1e',
            sidebar: '#17171a',
            bubble: '#243247',
            bubbleHighlight: '#2d3d58',
            codeBlock: '#1a1a1d',
            borderL1: '#26262a',
            borderL2: '#2e2e33',
            borderL3: '#38383e',
            borderL4: '#424249',
            labelPrimary: '#f2f2f3',
            labelSecondary: '#b9b9bf',
            labelTertiary: '#8b8b92',
            brand: '#7aaaff',
            hover: 'rgba(255, 255, 255, 0.06)',
            separator: '#26262a',
          },
        },
        radius: null,
      },
      glass: {
        palette: {
          light: {
            base: '#ffffff',
            layer1: '#ffffff',
            layer2: '#f2f6fb',
            overlay: '#fbfdff',
            module: '#eef4fb',
            sidebar: '#f4f8fd',
            bubble: '#e3edfb',
            bubbleHighlight: '#d5e4f8',
            codeBlock: '#eef4fb',
            borderL1: '#e3eaf3',
            borderL2: '#d6e1ee',
            borderL3: '#c7d5e6',
            borderL4: '#b6c7dc',
            labelPrimary: '#17202e',
            labelSecondary: '#526074',
            labelTertiary: '#7d8a9c',
            brand: '#4176e6',
            hover: 'rgba(20, 50, 90, 0.06)',
            separator: '#e1e8f1',
          },
          dark: {
            base: '#0f1218',
            layer1: '#151a22',
            layer2: '#1b222c',
            overlay: '#161c24',
            module: '#171d26',
            sidebar: '#11151b',
            bubble: '#203047',
            bubbleHighlight: '#2a3e5c',
            codeBlock: '#151b23',
            borderL1: '#26303c',
            borderL2: '#303c4a',
            borderL3: '#3b4858',
            borderL4: '#465566',
            labelPrimary: '#eef3fa',
            labelSecondary: '#b6c1cf',
            labelTertiary: '#8795a6',
            brand: '#7aaaff',
            hover: 'rgba(200, 220, 255, 0.07)',
            separator: '#26303c',
          },
        },
        radius: { xs: 6, sm: 10, md: 14, lg: 18, xl: 24, panel: 30 },
      },
      paper: {
        palette: {
          light: {
            base: '#faf7f0',
            layer1: '#fdfbf6',
            layer2: '#f4efe4',
            overlay: '#fdfbf6',
            module: '#f1ebdf',
            sidebar: '#f7f2e8',
            bubble: '#efe5d3',
            bubbleHighlight: '#e6d9c2',
            codeBlock: '#f3ede2',
            borderL1: '#e6ddce',
            borderL2: '#dbd0bd',
            borderL3: '#cec1aa',
            borderL4: '#bfb098',
            labelPrimary: '#2b2723',
            labelSecondary: '#5e574d',
            labelTertiary: '#8a8173',
            brand: '#8a5a32',
            hover: 'rgba(80, 60, 30, 0.06)',
            separator: '#e6ddce',
          },
          dark: {
            base: '#17150f',
            layer1: '#1e1b14',
            layer2: '#25211a',
            overlay: '#201c15',
            module: '#1c1912',
            sidebar: '#19160f',
            bubble: '#2f271b',
            bubbleHighlight: '#3b3122',
            codeBlock: '#1b1812',
            borderL1: '#2c271e',
            borderL2: '#383127',
            borderL3: '#453c2f',
            borderL4: '#524738',
            labelPrimary: '#eee8dd',
            labelSecondary: '#bcb3a4',
            labelTertiary: '#8d8474',
            brand: '#d8a46a',
            hover: 'rgba(255, 235, 200, 0.06)',
            separator: '#2c271e',
          },
        },
        radius: { xs: 3, sm: 6, md: 10, lg: 14, xl: 18, panel: 22 },
      },
      sakura: {
        palette: {
          light: {
            base: '#fff7f9',
            layer1: '#fffbfc',
            layer2: '#fbedf2',
            overlay: '#fffbfc',
            module: '#f9e8ee',
            sidebar: '#fdeff4',
            bubble: '#f9dbe6',
            bubbleHighlight: '#f4c9da',
            codeBlock: '#fceef3',
            borderL1: '#f2dbe4',
            borderL2: '#e8cbd6',
            borderL3: '#dcb8c6',
            borderL4: '#cfa3b4',
            labelPrimary: '#2c1f24',
            labelSecondary: '#624b55',
            labelTertiary: '#8f7681',
            brand: '#b84a76',
            hover: 'rgba(120, 40, 70, 0.06)',
            separator: '#f2dbe4',
          },
          dark: {
            base: '#171012',
            layer1: '#1f161a',
            layer2: '#281b20',
            overlay: '#21171b',
            module: '#1d1518',
            sidebar: '#1a1215',
            bubble: '#3a202b',
            bubbleHighlight: '#4a2937',
            codeBlock: '#1c1417',
            borderL1: '#302126',
            borderL2: '#3d2a31',
            borderL3: '#4b343d',
            borderL4: '#5a3f4a',
            labelPrimary: '#f6e9ee',
            labelSecondary: '#cbb1ba',
            labelTertiary: '#a08590',
            brand: '#ef8fb4',
            hover: 'rgba(255, 200, 220, 0.07)',
            separator: '#302126',
          },
        },
        radius: { xs: 5, sm: 9, md: 13, lg: 18, xl: 24, panel: 28 },
      },
      minimal: {
        palette: {
          light: {
            base: '#fbfbfb',
            layer1: '#ffffff',
            layer2: '#f4f4f4',
            overlay: '#ffffff',
            module: '#f1f1f1',
            sidebar: '#f7f7f7',
            bubble: '#ededed',
            bubbleHighlight: '#e2e2e2',
            codeBlock: '#f4f4f4',
            borderL1: '#e6e6e6',
            borderL2: '#dadada',
            borderL3: '#cecece',
            borderL4: '#c0c0c0',
            labelPrimary: '#111111',
            labelSecondary: '#555555',
            labelTertiary: '#888888',
            brand: '#4a5c78',
            hover: 'rgba(0, 0, 0, 0.045)',
            separator: '#e6e6e6',
          },
          dark: {
            base: '#101010',
            layer1: '#171717',
            layer2: '#1e1e1e',
            overlay: '#191919',
            module: '#161616',
            sidebar: '#121212',
            bubble: '#262626',
            bubbleHighlight: '#303030',
            codeBlock: '#171717',
            borderL1: '#242424',
            borderL2: '#2e2e2e',
            borderL3: '#393939',
            borderL4: '#444444',
            labelPrimary: '#f4f4f4',
            labelSecondary: '#b4b4b4',
            labelTertiary: '#858585',
            brand: '#8fa6c4',
            hover: 'rgba(255, 255, 255, 0.05)',
            separator: '#242424',
          },
        },
        radius: { xs: 2, sm: 3, md: 4, lg: 6, xl: 8, panel: 10 },
      },
    }

    /* ------------------------------------------------------------------ *
     * Fonts
     * ------------------------------------------------------------------ */

    const GENERIC_FAMILIES = new Set([
      'serif',
      'sans-serif',
      'monospace',
      'cursive',
      'fantasy',
      'system-ui',
      'ui-serif',
      'ui-sans-serif',
      'ui-monospace',
      'ui-rounded',
      'emoji',
      'math',
      'fangsong',
      '-apple-system',
      'blinkmacsystemfont',
    ])

    const FONT_TEXT_PRESETS = {
      follow: '',
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
      serif: '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", Georgia, "Times New Roman", serif',
      rounded: '"Yuanti SC", "YouYuan", "Microsoft YaHei UI", "PingFang SC", "Hiragino Sans GB", sans-serif',
      mono: '"JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", Menlo, Courier, monospace',
    }

    const FONT_CODE_PRESETS = {
      follow: '',
      mono: '"JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, "Liberation Mono", Menlo, Courier, monospace',
      sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
    }

    /* ------------------------------------------------------------------ *
     * Small utilities
     * ------------------------------------------------------------------ */

    function clampInt(value, min, max, fallback) {
      if (value === '' || value === null || value === undefined) return fallback
      const number = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(number)) return fallback
      return Math.min(max, Math.max(min, Math.round(number)))
    }

    function getStorage() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return null
        return window.localStorage
      } catch {
        return null
      }
    }

    function readJson(key, fallback) {
      const storage = getStorage()
      if (!storage) return fallback
      try {
        const raw = storage.getItem(key)
        if (raw === null || raw === undefined || raw === '') return fallback
        return JSON.parse(raw)
      } catch {
        return fallback
      }
    }

    function writeJson(key, value) {
      const storage = getStorage()
      if (!storage) return false
      try {
        storage.setItem(key, JSON.stringify(value))
        return true
      } catch {
        return false
      }
    }

    function removeKey(key) {
      const storage = getStorage()
      if (!storage) return
      try {
        storage.removeItem(key)
      } catch {
        /* an unavailable store simply keeps its old value */
      }
    }

    function roundAlpha(value) {
      return Math.round(value * 1000) / 1000
    }

    function parseHexColor(value) {
      if (typeof value !== 'string') return null
      const match = /^#([0-9a-f]{3,8})$/i.exec(value.trim())
      if (!match) return null
      let hex = match[1]
      if (hex.length === 3 || hex.length === 4) {
        hex = hex
          .split('')
          .map((char) => char + char)
          .join('')
      }
      if (hex.length === 6) hex += 'ff'
      if (hex.length !== 8) return null
      return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
        a: Number.parseInt(hex.slice(6, 8), 16) / 255,
      }
    }

    /** Convert `#rrggbb` to an rgba string with the requested opacity (0-100). */
    function rgbaFromHex(value, opacity) {
      const parsed = parseHexColor(value)
      if (!parsed) return value
      const alpha = Math.max(0, Math.min(1, (clampInt(opacity, 0, 100, 100) / 100) * parsed.a))
      return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${roundAlpha(alpha)})`
    }

    function normalizeFontList(value) {
      if (typeof value !== 'string') return ''
      return value
        .split(',')
        .map((name) =>
          name
            .replace(/["'\\<>{}\[\];\u0000-\u001f\u007f]/gu, '')
            .replace(/\s+/gu, ' ')
            .trim(),
        )
        .filter((name) => name !== '')
        .slice(0, 12)
        .map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`))
        .join(', ')
        .slice(0, 400)
    }

    function resolveFont(id, custom, presets) {
      if (id === 'custom') return normalizeFontList(custom)
      return presets[id] ?? ''
    }

    function sanitizeImageUrl(value) {
      if (typeof value !== 'string') return null
      const raw = value.trim()
      if (raw === '' || raw.length > 2048) return null
      if (/[\u0000-\u001f"\\<>]/.test(raw)) return null
      let url
      try {
        url = new URL(raw)
      } catch {
        return null
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
      if (url.username !== '' || url.password !== '') return null
      return url.href
    }

    function isSafeDataImage(value) {
      if (typeof value !== 'string') return false
      if (value.length === 0 || value.length > WALLPAPER_MAX_CHARS) return false
      return /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/i.test(value)
    }

    function cssUrl(value) {
      const escaped = String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\n\r\f]/g, '')
      return `url("${escaped}")`
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 KB'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    function truncateText(value, max) {
      const text = typeof value === 'string' ? value : ''
      return text.length > max ? `${text.slice(0, max - 1)}…` : text
    }

    /* ------------------------------------------------------------------ *
     * Settings and wallpaper normalization
     * ------------------------------------------------------------------ */

    function normalizeSettings(raw) {
      const source = raw && typeof raw === 'object' ? raw : {}
      return {
        style: STYLE_IDS.includes(source.style) ? source.style : DEFAULT_SETTINGS.style,
        surfaceOpacity: clampInt(source.surfaceOpacity, 0, 100, DEFAULT_SETTINGS.surfaceOpacity),
        wallpaperBlur: clampInt(source.wallpaperBlur, 0, 24, DEFAULT_SETTINGS.wallpaperBlur),
        wallpaperDim: clampInt(source.wallpaperDim, 0, 70, DEFAULT_SETTINGS.wallpaperDim),
        fontText: FONT_TEXT_IDS.includes(source.fontText) ? source.fontText : DEFAULT_SETTINGS.fontText,
        customTextFont:
          typeof source.customTextFont === 'string' ? source.customTextFont.slice(0, 200) : '',
        fontCode: FONT_CODE_IDS.includes(source.fontCode) ? source.fontCode : DEFAULT_SETTINGS.fontCode,
        customCodeFont:
          typeof source.customCodeFont === 'string' ? source.customCodeFont.slice(0, 200) : '',
      }
    }

    function normalizeWallpaper(raw) {
      if (!raw || typeof raw !== 'object') return null
      if (raw.kind === 'url') {
        const safe = sanitizeImageUrl(raw.value)
        if (!safe) return null
        return {
          kind: 'url',
          value: safe,
          name: typeof raw.name === 'string' && raw.name !== '' ? raw.name.slice(0, 300) : safe,
          width: 0,
          height: 0,
          bytes: 0,
        }
      }
      if (raw.kind === 'data') {
        if (!isSafeDataImage(raw.value)) return null
        return {
          kind: 'data',
          value: raw.value,
          name: typeof raw.name === 'string' && raw.name !== '' ? raw.name.slice(0, 200) : 'wallpaper',
          width: Number.isFinite(raw.width) ? Math.max(0, Math.round(raw.width)) : 0,
          height: Number.isFinite(raw.height) ? Math.max(0, Math.round(raw.height)) : 0,
          bytes: Number.isFinite(raw.bytes)
            ? Math.max(0, Math.round(raw.bytes))
            : Math.round((raw.value.length * 3) / 4),
        }
      }
      return null
    }

    /* ------------------------------------------------------------------ *
     * Token layer
     * ------------------------------------------------------------------ */

    function buildTokens(rawSettings) {
      const settings = normalizeSettings(rawSettings)
      const style = STYLES[settings.style] ?? STYLES.follow
      const palette = style.palette
      const hasStyle = settings.style !== 'follow'
      const opacity = settings.surfaceOpacity
      const overlayOpacity = Math.max(88, opacity)
      const tokens = {}

      const surfaces = [
        ['--dsw-alias-bg-base', 'base', opacity],
        ['--dsw-alias-bg-layer-1', 'layer1', opacity],
        ['--dsw-alias-bg-layer-2', 'layer2', opacity],
        ['--dsw-alias-bg-overlay', 'overlay', overlayOpacity],
        ['--dsw-alias-bg-module-platform', 'module', opacity],
        ['--dsw-specific-sidebar-fill', 'sidebar', opacity],
        ['--dsw-specific-bubble', 'bubble', opacity],
        ['--dsw-specific-bubble-highlight', 'bubbleHighlight', opacity],
        ['--dsw-alias-markdown-code-block', 'codeBlock', opacity],
      ]

      if (hasStyle || opacity < 100) {
        for (const [name, key, alpha] of surfaces) {
          tokens[name] = {
            light: rgbaFromHex(palette.light[key], alpha),
            dark: rgbaFromHex(palette.dark[key], alpha),
          }
        }
      }

      if (hasStyle) {
        const pairs = [
          ['--dsw-alias-border-l1', 'borderL1'],
          ['--dsw-alias-border-l2', 'borderL2'],
          ['--dsw-alias-border-l3', 'borderL3'],
          ['--dsw-alias-border-l4', 'borderL4'],
          ['--dsw-alias-label-primary', 'labelPrimary'],
          ['--dsw-alias-label-secondary', 'labelSecondary'],
          ['--dsw-alias-label-tertiary', 'labelTertiary'],
          ['--dsw-alias-brand-primary', 'brand'],
          ['--dsw-alias-interactive-bg-hover', 'hover'],
          ['--dsw-alias-separator-primary', 'separator'],
        ]
        for (const [name, key] of pairs) {
          tokens[name] = { light: palette.light[key], dark: palette.dark[key] }
        }
        if (style.radius) {
          for (const [key, value] of Object.entries(style.radius)) {
            tokens[`--dsw-radius-${key}`] = { light: `${value}px`, dark: `${value}px` }
          }
        }
      }

      const textFont = resolveFont(settings.fontText, settings.customTextFont, FONT_TEXT_PRESETS)
      if (textFont !== '') {
        tokens['--dsh-font-family-text'] = { light: textFont, dark: textFont }
      }
      const codeFont = resolveFont(settings.fontCode, settings.customCodeFont, FONT_CODE_PRESETS)
      if (codeFont !== '') {
        tokens['--dsh-font-family-code'] = { light: codeFont, dark: codeFont }
      }

      return tokens
    }

    /* ------------------------------------------------------------------ *
     * Wallpaper CSS
     * ------------------------------------------------------------------ */

    function buildWallpaperCss(value) {
      const selector = `html[${WALLPAPER_ATTR}]`
      return `
${selector} { background-color: Canvas; }
${selector} body { background-color: transparent !important; }
${selector} body::before {
  content: "";
  position: fixed;
  inset: -28px;
  z-index: -2;
  background-image: ${cssUrl(value)};
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  filter: var(${FILTER_VAR}, none);
  pointer-events: none;
}
${selector} body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: -1;
  background: rgba(255, 255, 255, var(${DIM_VAR}, 0));
  pointer-events: none;
}
${selector} body[data-ds-dark-theme]::after {
  background: rgba(0, 0, 0, var(${DIM_VAR}, 0));
}
`
    }

    /* ------------------------------------------------------------------ *
     * Image preparation
     * ------------------------------------------------------------------ */

    function readImageSize(source) {
      return new Promise((resolve) => {
        if (typeof Image !== 'function') {
          resolve({ width: 0, height: 0 })
          return
        }
        const image = new Image()
        image.onload = () => {
          resolve({
            width: image.naturalWidth || image.width || 0,
            height: image.naturalHeight || image.height || 0,
          })
        }
        image.onerror = () => resolve({ width: 0, height: 0 })
        image.src = source
      })
    }

    function compressImage(source) {
      return new Promise((resolve, reject) => {
        if (
          typeof Image !== 'function' ||
          typeof document === 'undefined' ||
          typeof document.createElement !== 'function'
        ) {
          reject(new Error('unsupported'))
          return
        }
        const image = new Image()
        image.onerror = () => reject(new Error('decode-failed'))
        image.onload = () => {
          try {
            const width = image.naturalWidth || image.width || 0
            const height = image.naturalHeight || image.height || 0
            if (!width || !height) {
              reject(new Error('decode-failed'))
              return
            }
            const baseScale = Math.min(1, WALLPAPER_MAX_EDGE / Math.max(width, height))
            const canvas = document.createElement('canvas')
            const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
            if (!canvas || !context) {
              reject(new Error('unsupported'))
              return
            }
            let best = ''
            let bestWidth = 0
            let bestHeight = 0
            for (const attempt of WALLPAPER_ATTEMPTS) {
              const nextWidth = Math.max(1, Math.round(width * baseScale * attempt.scale))
              const nextHeight = Math.max(1, Math.round(height * baseScale * attempt.scale))
              canvas.width = nextWidth
              canvas.height = nextHeight
              context.clearRect(0, 0, nextWidth, nextHeight)
              context.drawImage(image, 0, 0, nextWidth, nextHeight)
              const candidate = canvas.toDataURL('image/webp', attempt.quality)
              if (!isSafeDataImage(candidate)) continue
              best = candidate
              bestWidth = nextWidth
              bestHeight = nextHeight
              if (candidate.length <= WALLPAPER_MAX_CHARS) break
            }
            if (best === '' || best.length > WALLPAPER_MAX_CHARS) {
              reject(new Error('too-large'))
              return
            }
            resolve({
              kind: 'data',
              value: best,
              width: bestWidth,
              height: bestHeight,
              bytes: Math.round((best.length * 3) / 4),
            })
          } catch {
            reject(new Error('decode-failed'))
          }
        }
        image.src = source
      })
    }

    async function prepareWallpaperFile(file) {
      if (!file || typeof file !== 'object') throw new Error('unsupported')
      const type = typeof file.type === 'string' ? file.type : ''
      if (type !== '' && !type.startsWith('image/')) throw new Error('unsupported')
      if (typeof file.size === 'number' && file.size > WALLPAPER_MAX_FILE_BYTES) {
        throw new Error('too-large')
      }
      if (typeof FileReader !== 'function') throw new Error('unsupported')

      const source = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(new Error('read-failed'))
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
        reader.readAsDataURL(file)
      })
      if (!isSafeDataImage(source)) throw new Error('unsupported')

      const size = await readImageSize(source)
      const oversized =
        size.width === 0 ||
        size.height === 0 ||
        size.width > WALLPAPER_MAX_EDGE ||
        size.height > WALLPAPER_MAX_EDGE ||
        source.length > WALLPAPER_MAX_CHARS

      if (!oversized) {
        return {
          kind: 'data',
          value: source,
          name: typeof file.name === 'string' && file.name !== '' ? file.name : 'wallpaper',
          width: size.width,
          height: size.height,
          bytes: Math.round((source.length * 3) / 4),
        }
      }

      const compressed = await compressImage(source)
      return {
        ...compressed,
        name: typeof file.name === 'string' && file.name !== '' ? file.name : 'wallpaper',
      }
    }

    /* ------------------------------------------------------------------ *
     * Store and runtime
     * ------------------------------------------------------------------ */

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          value = next
          for (const listener of [...listeners]) {
            try {
              listener(value)
            } catch {
              /* a listener must not break the store */
            }
          }
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    let runtime = null

    function createRuntime() {
      const settings = createStore(normalizeSettings(readJson(SETTINGS_KEY)))
      const wallpaper = createStore(normalizeWallpaper(readJson(WALLPAPER_KEY)))

      function setSettings(patch) {
        const next = normalizeSettings({ ...settings.get(), ...patch })
        settings.set(next)
        writeJson(SETTINGS_KEY, next)
        return next
      }

      function setWallpaper(value) {
        const next = normalizeWallpaper(value)
        let persisted
        if (next === null) {
          removeKey(WALLPAPER_KEY)
          persisted = true
        } else {
          persisted = writeJson(WALLPAPER_KEY, next)
        }
        wallpaper.set(next)
        return persisted
      }

      function reset() {
        const next = normalizeSettings(DEFAULT_SETTINGS)
        settings.set(next)
        writeJson(SETTINGS_KEY, next)
        removeKey(WALLPAPER_KEY)
        wallpaper.set(null)
      }

      return { settings, wallpaper, setSettings, setWallpaper, reset }
    }

    function getRuntime() {
      if (runtime === null) runtime = createRuntime()
      return runtime
    }

    /* ------------------------------------------------------------------ *
     * Style tags and appearance application
     * ------------------------------------------------------------------ */

    function findStyleTag(id) {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null
      try {
        return document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`)
      } catch {
        return null
      }
    }

    function installStaticStyle() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      if (findStyleTag(STATIC_CSS_ID)) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = STATIC_CSS_ID
      tag.textContent = STATIC_CSS
      document.head.append(tag)
      return () => {
        if (typeof tag.remove === 'function') tag.remove()
      }
    }

    function applyAppearance(ctx) {
      const app = getRuntime()
      const root = typeof document !== 'undefined' ? document.documentElement : null
      if (!root) return () => {}
      let tokenDispose = null
      let lastTokenKey
      let wallpaperTag = null
      let lastWallpaper

      function currentTheme() {
        if (ctx.theme) return ctx.theme
        if (typeof ctx.get === 'function') return ctx.get('theme')
        return undefined
      }

      function applyTokens() {
        const theme = currentTheme()
        if (!theme || typeof theme.overrideTokens !== 'function') return
        const tokens = buildTokens(app.settings.get())
        const key = JSON.stringify(tokens)
        if (key === lastTokenKey) return
        lastTokenKey = key
        if (Object.keys(tokens).length === 0) {
          if (tokenDispose) {
            try {
              tokenDispose()
            } catch {
              /* the layer may already be gone */
            }
            tokenDispose = null
          }
          return
        }
        try {
          tokenDispose = theme.overrideTokens(TOKEN_SOURCE, tokens)
        } catch (error) {
          ctx.logger?.warn?.('dsh-ui-beautify: theme token override rejected', error)
        }
      }

      function syncWallpaperTag(wallpaper) {
        if (wallpaper === lastWallpaper) return
        lastWallpaper = wallpaper
        if (!wallpaper) {
          if (wallpaperTag && typeof wallpaperTag.remove === 'function') wallpaperTag.remove()
          wallpaperTag = null
          return
        }
        const css = buildWallpaperCss(wallpaper.value)
        if (!wallpaperTag) {
          wallpaperTag = findStyleTag(WALLPAPER_CSS_ID)
          if (!wallpaperTag && typeof document !== 'undefined' && document.head) {
            wallpaperTag = document.createElement('style')
            wallpaperTag.dataset.plugin = PLUGIN_ID
            wallpaperTag.dataset.pluginCss = WALLPAPER_CSS_ID
            document.head.append(wallpaperTag)
          }
        }
        if (wallpaperTag) wallpaperTag.textContent = css
      }

      function applyNow() {
        const settings = app.settings.get()
        const wallpaper = app.wallpaper.get()

        root.setAttribute(ROOT_ATTR, 'on')
        applyTokens()

        if (wallpaper) {
          root.setAttribute(WALLPAPER_ATTR, 'on')
          root.style.setProperty(
            FILTER_VAR,
            settings.wallpaperBlur > 0 ? `blur(${settings.wallpaperBlur}px)` : 'none',
          )
          root.style.setProperty(DIM_VAR, String(settings.wallpaperDim / 100))
          syncWallpaperTag(wallpaper)
        } else {
          root.removeAttribute(WALLPAPER_ATTR)
          root.style.removeProperty(FILTER_VAR)
          root.style.removeProperty(DIM_VAR)
          syncWallpaperTag(null)
        }
      }

      const unsubscribeSettings = app.settings.subscribe(applyNow)
      const unsubscribeWallpaper = app.wallpaper.subscribe(applyNow)
      applyNow()

      return () => {
        unsubscribeSettings()
        unsubscribeWallpaper()
        if (tokenDispose) {
          try {
            tokenDispose()
          } catch {
            /* the layer may already be gone */
          }
          tokenDispose = null
        }
        root.removeAttribute(ROOT_ATTR)
        root.removeAttribute(WALLPAPER_ATTR)
        root.style.removeProperty(FILTER_VAR)
        root.style.removeProperty(DIM_VAR)
        if (wallpaperTag && typeof wallpaperTag.remove === 'function') wallpaperTag.remove()
        wallpaperTag = null
      }
    }

    /* ------------------------------------------------------------------ *
     * React hooks and components
     * ------------------------------------------------------------------ */

    function useStore(store) {
      const [value, setValue] = useState(store.get)
      useEffect(() => store.subscribe(setValue), [store])
      return value
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dub-row' },
        h(
          'div',
          { className: 'dub-row-main' },
          h('div', { className: 'dub-row-title' }, props.title),
          props.desc ? h('div', { className: 'dub-row-desc' }, props.desc) : null,
        ),
        h('div', { className: 'dub-control' }, props.children),
      )
    }

    function Section(props) {
      return h(
        'section',
        { className: 'dub-card' },
        h(
          'div',
          { className: 'dub-card-head' },
          h('h3', { className: 'dub-h2' }, props.title),
          props.desc ? h('p', { className: 'dub-hint' }, props.desc) : null,
        ),
        h('div', { className: 'dub-card-body' }, props.children),
      )
    }

    function SliderRow(props) {
      return h(
        'div',
        { className: 'dub-row' },
        h(
          'div',
          { className: 'dub-row-main' },
          h('div', { className: 'dub-row-title' }, props.title),
          props.desc ? h('div', { className: 'dub-row-desc' }, props.desc) : null,
        ),
        h(
          'div',
          { className: 'dub-control' },
          h('input', {
            className: 'dub-range',
            type: 'range',
            min: props.min,
            max: props.max,
            step: 1,
            value: props.value,
            'aria-label': props.title,
            'aria-valuetext': `${props.value}${props.unit}`,
            onChange: (event) => props.onChange(Number(event.target.value)),
          }),
          h('span', { className: 'dub-value' }, `${props.value}${props.unit}`),
        ),
      )
    }

    function TextCommitField(props) {
      const [draft, setDraft] = useState(props.value)
      useEffect(() => {
        setDraft(props.value)
      }, [props.value])
      const commit = () => {
        const next = typeof draft === 'string' ? draft : ''
        if (next !== props.value) props.onCommit(next)
      }
      return h('input', {
        className: 'dub-input',
        type: 'text',
        value: draft,
        placeholder: props.placeholder,
        'aria-label': props.ariaLabel,
        spellCheck: false,
        autoComplete: 'off',
        maxLength: 200,
        onChange: (event) => setDraft(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          }
        },
      })
    }

    function wallpaperMeta(wallpaper, t) {
      if (!wallpaper) return ''
      if (wallpaper.kind === 'url') {
        return `${t('wallpaper.remote')} · ${truncateText(wallpaper.name, 72)}`
      }
      const dimensions =
        wallpaper.width > 0 && wallpaper.height > 0 ? `${wallpaper.width}×${wallpaper.height} · ` : ''
      return `${t('wallpaper.local')} · ${dimensions}${formatBytes(wallpaper.bytes)}`
    }

    function wallpaperErrorKey(error) {
      const code = error && typeof error.message === 'string' ? error.message : ''
      if (code === 'too-large') return 'wallpaper.tooLarge'
      if (code === 'unsupported') return 'wallpaper.unsupported'
      if (code === 'decode-failed') return 'wallpaper.decodeFailed'
      return 'wallpaper.readFailed'
    }

    function SettingsPage(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => key
      const app = getRuntime()
      const settings = useStore(app.settings)
      const wallpaper = useStore(app.wallpaper)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [urlDraft, setUrlDraft] = useState('')
      const [resetArmed, setResetArmed] = useState(false)
      const fileRef = useRef(null)

      const update = useCallback(
        (patch) => {
          app.setSettings(patch)
          setResetArmed(false)
        },
        [app],
      )

      const handleFile = useCallback(
        async (event) => {
          const input = event?.target
          const file = input && input.files && input.files[0] ? input.files[0] : null
          if (input) input.value = ''
          if (!file) return
          setBusy(true)
          setNotice(null)
          try {
            const prepared = await prepareWallpaperFile(file)
            const persisted = app.setWallpaper(prepared)
            setNotice({
              kind: persisted ? 'ok' : 'error',
              key: persisted ? 'wallpaper.saved' : 'wallpaper.notPersisted',
            })
            setResetArmed(false)
          } catch (error) {
            setNotice({ kind: 'error', key: wallpaperErrorKey(error) })
          } finally {
            setBusy(false)
          }
        },
        [app],
      )

      const handleUrl = useCallback(() => {
        const safe = sanitizeImageUrl(urlDraft)
        if (!safe) {
          setNotice({ kind: 'error', key: 'wallpaper.invalidUrl' })
          return
        }
        const persisted = app.setWallpaper({
          kind: 'url',
          value: safe,
          name: safe,
          width: 0,
          height: 0,
          bytes: 0,
        })
        setNotice({
          kind: persisted ? 'ok' : 'error',
          key: persisted ? 'wallpaper.saved' : 'wallpaper.notPersisted',
        })
        setResetArmed(false)
      }, [app, urlDraft])

      const handleClear = useCallback(() => {
        app.setWallpaper(null)
        setNotice({ kind: 'ok', key: 'wallpaper.cleared' })
        setResetArmed(false)
      }, [app])

      const handleReset = useCallback(() => {
        if (!resetArmed) {
          setResetArmed(true)
          setNotice({ kind: 'ok', key: 'reset.hint' })
          return
        }
        app.reset()
        setResetArmed(false)
        setNotice({ kind: 'ok', key: 'reset.done' })
      }, [app, resetArmed])

      const styleButtons = STYLE_IDS.map((id) => {
        const palette = STYLES[id].palette
        const swatch = `linear-gradient(135deg, ${palette.light.base} 0 50%, ${palette.dark.base} 50% 100%)`
        return h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'dub-preset',
            'aria-pressed': settings.style === id ? 'true' : 'false',
            onClick: () => update({ style: id }),
          },
          h('span', { className: 'dub-swatch', style: { background: swatch } }),
          h('span', { className: 'dub-preset-name' }, t(`style.${id}`)),
          h('span', { className: 'dub-preset-desc' }, t(`style.${id}.desc`)),
        )
      })

      const textFontOptions = FONT_TEXT_IDS.map((id) =>
        h('option', { key: id, value: id }, t(`font.${id}`)),
      )
      const codeFontOptions = FONT_CODE_IDS.map((id) =>
        h('option', { key: id, value: id }, t(`font.${id}`)),
      )

      const textFontRows = [
        h(
          Row,
          { key: 'text-font', title: t('font.text'), desc: t('font.desc') },
          h(
            'select',
            {
              className: 'dub-select',
              value: settings.fontText,
              'aria-label': t('font.text'),
              onChange: (event) => update({ fontText: event.target.value }),
            },
            ...textFontOptions,
          ),
        ),
      ]
      if (settings.fontText === 'custom') {
        textFontRows.push(
          h(
            Row,
            { key: 'text-font-custom', title: t('font.customLabel'), desc: t('font.customHint') },
            h(TextCommitField, {
              value: settings.customTextFont,
              placeholder: t('font.customPlaceholder'),
              ariaLabel: t('font.customLabel'),
              onCommit: (value) => update({ customTextFont: value }),
            }),
          ),
        )
      }

      const codeFontRows = [
        h(
          Row,
          { key: 'code-font', title: t('font.code') },
          h(
            'select',
            {
              className: 'dub-select',
              value: settings.fontCode,
              'aria-label': t('font.code'),
              onChange: (event) => update({ fontCode: event.target.value }),
            },
            ...codeFontOptions,
          ),
        ),
      ]
      if (settings.fontCode === 'custom') {
        codeFontRows.push(
          h(
            Row,
            { key: 'code-font-custom', title: t('font.customLabel'), desc: t('font.customHint') },
            h(TextCommitField, {
              value: settings.customCodeFont,
              placeholder: t('font.customPlaceholder'),
              ariaLabel: t('font.customLabel'),
              onCommit: (value) => update({ customCodeFont: value }),
            }),
          ),
        )
      }

      const wallpaperPreview = wallpaper
        ? h('div', {
            className: 'dub-preview',
            style: { backgroundImage: cssUrl(wallpaper.value) },
            role: 'img',
            'aria-label': wallpaperMeta(wallpaper, t),
          })
        : h('div', { className: 'dub-preview dub-preview-empty' }, t('wallpaper.none'))

      return h(
        'div',
        { className: 'dsh-ui-beautify-page' },
        h(
          'header',
          { className: 'dub-head' },
          h('h2', { className: 'dub-title' }, t('title')),
          h('p', { className: 'dub-subtitle' }, t('subtitle')),
        ),
        notice
          ? h(
              'div',
              {
                className: 'dub-notice',
                'data-kind': notice.kind,
                role: notice.kind === 'error' ? 'alert' : 'status',
              },
              t(notice.key),
            )
          : null,
        h(
          Section,
          { title: t('style.title'), desc: t('style.desc') },
          h('div', { className: 'dub-grid', role: 'group', 'aria-label': t('style.title') }, ...styleButtons),
        ),
        h(
          Section,
          { title: t('surface.title'), desc: t('surface.desc') },
          h(SliderRow, {
            title: t('surface.opacity'),
            desc: t('surface.opacityHint'),
            min: 0,
            max: 100,
            unit: '%',
            value: settings.surfaceOpacity,
            onChange: (value) => update({ surfaceOpacity: value }),
          }),
          h(SliderRow, {
            title: t('surface.blur'),
            min: 0,
            max: 24,
            unit: 'px',
            value: settings.wallpaperBlur,
            onChange: (value) => update({ wallpaperBlur: value }),
          }),
          h(SliderRow, {
            title: t('surface.dim'),
            desc: t('surface.dimHint'),
            min: 0,
            max: 70,
            unit: '%',
            value: settings.wallpaperDim,
            onChange: (value) => update({ wallpaperDim: value }),
          }),
        ),
        h(
          Section,
          { title: t('wallpaper.title'), desc: t('wallpaper.desc') },
          h('div', { className: 'dub-wallpaper' }, wallpaperPreview),
          h('p', { className: 'dub-hint' }, wallpaperMeta(wallpaper, t) || t('wallpaper.none')),
          wallpaper ? h('p', { className: 'dub-hint' }, t('wallpaper.visibleHint')) : null,
          h(
            'div',
            { className: 'dub-wallpaper-actions' },
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif',
              style: { display: 'none' },
              onChange: handleFile,
            }),
            h(
              'button',
              {
                className: 'dub-btn dub-btn-primary',
                type: 'button',
                disabled: busy,
                onClick: () => fileRef.current?.click?.(),
              },
              busy ? t('wallpaper.uploading') : t('wallpaper.upload'),
            ),
            wallpaper
              ? h('button', { className: 'dub-btn', type: 'button', onClick: handleClear }, t('wallpaper.clear'))
              : null,
          ),
          h(
            'div',
            { className: 'dub-url-row' },
            h('input', {
              className: 'dub-input',
              type: 'url',
              value: urlDraft,
              placeholder: t('wallpaper.urlPlaceholder'),
              'aria-label': t('wallpaper.url'),
              spellCheck: false,
              autoComplete: 'off',
              onChange: (event) => setUrlDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleUrl()
                }
              },
            }),
            h('button', { className: 'dub-btn', type: 'button', onClick: handleUrl }, t('wallpaper.applyUrl')),
          ),
          h('p', { className: 'dub-hint' }, t('wallpaper.remoteHint')),
        ),
        h(
          Section,
          { title: t('font.title') },
          ...textFontRows,
          ...codeFontRows,
        ),
        h(
          'footer',
          { className: 'dub-footer' },
          h(
            'button',
            {
              className: resetArmed ? 'dub-btn dub-btn-danger' : 'dub-btn',
              type: 'button',
              onClick: handleReset,
            },
            resetArmed ? t('reset.confirm') : t('reset'),
          ),
          h('span', { className: 'dub-hint' }, t('privacy')),
        ),
      )
    }

    /* ------------------------------------------------------------------ *
     * Static settings-page CSS
     * ------------------------------------------------------------------ */

    const STATIC_CSS = `
.dsh-ui-beautify-page {
  --dub-border: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  --dub-border-strong: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.38));
  --dub-surface: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.04));
  --dub-soft: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.08));
  --dub-muted: var(--dsw-alias-label-secondary, rgba(127, 127, 127, 0.92));
  --dub-faint: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.72));
  --dub-accent: var(--dsw-alias-brand-primary, #2f6fed);
  --dub-on-accent: var(--dsw-static-neutral-00, #fff);
  --dub-error: var(--dsw-alias-state-error-primary, #c0392b);
  --dub-hover: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 980px;
  padding: 4px 2px 32px;
  color: inherit;
  font-size: 13px;
  line-height: 1.55;
}
.dsh-ui-beautify-page,
.dsh-ui-beautify-page *,
.dsh-ui-beautify-page *::before,
.dsh-ui-beautify-page *::after {
  box-sizing: border-box;
}
body[data-ds-dark-theme] .dsh-ui-beautify-page {
  --dub-on-accent: var(--dsw-static-neutral-bluish-1000, #0f1115);
}
.dub-head { display: flex; flex-direction: column; gap: 4px; }
.dub-title { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 600; }
.dub-subtitle { margin: 0; color: var(--dub-muted); max-width: 68ch; }
.dub-card {
  border: 1px solid var(--dub-border);
  border-radius: 10px;
  background: var(--dub-surface);
  overflow: hidden;
}
.dub-card-head {
  padding: 13px 15px 11px;
  border-bottom: 1px solid var(--dub-border);
  background: var(--dub-soft);
}
.dub-h2 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
.dub-card-body { padding: 2px 15px 6px; }
.dub-hint { margin: 0; color: var(--dub-faint); font-size: 12px; line-height: 1.5; }
.dub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 0;
  border-top: 1px solid var(--dub-border);
}
.dub-row:first-child { border-top: 0; }
.dub-row-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dub-row-title { font-weight: 500; }
.dub-row-desc { color: var(--dub-faint); font-size: 12px; line-height: 1.45; }
.dub-control {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  min-width: 220px;
}
.dub-range { width: 180px; accent-color: var(--dub-accent); }
.dub-value {
  min-width: 44px;
  text-align: right;
  color: var(--dub-muted);
  font-variant-numeric: tabular-nums;
}
.dub-input, .dub-select {
  min-width: 180px;
  max-width: 280px;
  padding: 6px 9px;
  border: 1px solid var(--dub-border);
  border-radius: 7px;
  background: var(--dub-soft);
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.35;
}
.dub-input::placeholder { color: var(--dub-faint); }
.dub-input:focus, .dub-select:focus {
  outline: 2px solid var(--dub-accent);
  outline-offset: 0;
}
.dub-btn {
  appearance: none;
  border: 1px solid var(--dub-border);
  border-radius: 7px;
  background: transparent;
  color: inherit;
  padding: 6px 11px;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.3;
  cursor: pointer;
  white-space: nowrap;
}
.dub-btn:hover:not(:disabled) { background: var(--dub-hover); }
.dub-btn:focus-visible { outline: 2px solid var(--dub-accent); outline-offset: 1px; }
.dub-btn:disabled { opacity: 0.5; cursor: default; }
.dub-btn-primary {
  border-color: var(--dub-accent);
  background: var(--dub-accent);
  color: var(--dub-on-accent);
  font-weight: 600;
}
.dub-btn-primary:hover:not(:disabled) { background: var(--dub-accent); filter: brightness(1.06); }
.dub-btn-danger { border-color: var(--dub-error); color: var(--dub-error); }
.dub-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  padding: 12px 0 14px;
}
.dub-preset {
  appearance: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px;
  border: 1px solid var(--dub-border);
  border-radius: 9px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dub-preset:hover { background: var(--dub-hover); }
.dub-preset[aria-pressed='true'] {
  border-color: var(--dub-accent);
  box-shadow: inset 0 0 0 1px var(--dub-accent);
}
.dub-preset:focus-visible { outline: 2px solid var(--dub-accent); outline-offset: 1px; }
.dub-swatch {
  display: block;
  height: 32px;
  border: 1px solid var(--dub-border-strong);
  border-radius: 6px;
}
.dub-preset-name { font-size: 13px; font-weight: 600; }
.dub-preset-desc { font-size: 11.5px; line-height: 1.45; color: var(--dub-faint); }
.dub-wallpaper { padding-top: 12px; }
.dub-preview {
  height: 150px;
  border: 1px solid var(--dub-border);
  border-radius: 8px;
  background-color: var(--dub-soft);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.dub-preview-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dub-faint);
  font-size: 12px;
}
.dub-wallpaper-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px 0 4px;
}
.dub-url-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 4px 0; }
.dub-url-row .dub-input { flex: 1 1 240px; max-width: none; }
.dub-notice {
  padding: 8px 11px;
  border: 1px solid var(--dub-border);
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.5;
}
.dub-notice[data-kind='error'] {
  color: var(--dub-error);
  border-color: var(--dub-error);
}
.dub-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 6px;
  border-top: 1px solid var(--dub-border);
  flex-wrap: wrap;
}
@media (max-width: 640px) {
  .dub-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .dub-control { min-width: 0; justify-content: flex-start; }
  .dub-range { width: 100%; }
  .dub-input, .dub-select { max-width: none; width: 100%; }
}
`

    /* ------------------------------------------------------------------ *
     * Plugin entry
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      const t = ctx.locale.bind(NS)

      ctx.effect(
        () => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }),
        'dsh-ui-beautify: dictionaries',
      )

      ctx.effect(() => installStaticStyle(), 'dsh-ui-beautify: settings styles')

      ctx.effect(() => applyAppearance(ctx), 'dsh-ui-beautify: appearance')

      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: PLUGIN_ID,
                order: 38,
                label: () => t('nav'),
                locale: NS,
              },
              (props) => h(SettingsPage, { ...props, t }),
            ),
          ),
        'dsh-ui-beautify: settings section',
      )
    }

    return {
      inject: ['slots', 'locale', 'theme'],
      apply,
      __test: {
        DEFAULT_SETTINGS,
        DICT,
        STYLE_IDS,
        FONT_TEXT_IDS,
        FONT_CODE_IDS,
        STYLES,
        FONT_TEXT_PRESETS,
        FONT_CODE_PRESETS,
        STATIC_CSS,
        SETTINGS_KEY,
        WALLPAPER_KEY,
        ROOT_ATTR,
        WALLPAPER_ATTR,
        buildTokens,
        buildWallpaperCss,
        cssUrl,
        formatBytes,
        isSafeDataImage,
        normalizeFontList,
        normalizeSettings,
        normalizeWallpaper,
        parseHexColor,
        prepareWallpaperFile,
        rgbaFromHex,
        sanitizeImageUrl,
        truncateText,
        SettingsPage,
        getRuntime,
      },
    }
  },
})
