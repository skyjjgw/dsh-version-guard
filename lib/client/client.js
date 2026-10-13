/**
 * DSH 版本守卫 · 客户端
 *
 * 这是一个 classic script（不是 ES module）—— DSH 前端用 <script src> 加载它，
 * 顶层出现 import/export 会直接让插件加载失败。它必须调用
 *   window.__ModuleLoader__.load({ id: '<package name>', factory })
 * 且 id 必须与 package.json 的 name 完全一致。
 *
 * 这里刻意不重复实现恢复界面：宿主插件已经把完整的离线恢复页挂在
 * /dsh-version-guard/ 上，客户端只注册一个设置页并把那一页放进 iframe。
 * 这样「DSH 内」和「DSH 外」用的是同一套界面、同一套 API、同一套判断，
 * 不会出现两边行为不一致的情况。
 */
window.__ModuleLoader__.load({
  id: 'dsh-version-guard',
  factory: function (require) {
    'use strict'
    var React = require('react')

    /** Mount prefix of the guard's own routes, registered by the host half. */
    var GUARD_PATH = '/dsh-version-guard/'
    var NS = 'dsh-version-guard'

    /** Minimal bilingual dictionary; DSH supplies the resolved language. */
    var MESSAGES = {
      zh: { nav: '版本守卫' },
      en: { nav: 'Version Guard' },
    }

    /**
     * Resolve a guard path against the document base so a reverse proxy that
     * serves DSH under a path prefix still finds it.
     * @param {string} suffix
     * @returns {string}
     */
    function guardUrl(suffix) {
      var relative = (GUARD_PATH + (suffix || '').replace(/^\/+/, '')).replace(/^\/+/, '')
      try {
        return new URL(relative, document.baseURI).pathname
      } catch (error) {
        return GUARD_PATH + (suffix || '')
      }
    }

    /** The embedded recovery page, filling the settings content area. */
    function GuardFrame() {
      return React.createElement('div', {
        style: { height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 },
      }, React.createElement('iframe', {
        src: guardUrl(''),
        title: 'DSH 版本守卫',
        style: {
          flex: '1 1 auto',
          width: '100%',
          minHeight: '520px',
          border: 'none',
          background: 'transparent',
        },
      }))
    }

    /** Shown when the host half did not mount its routes. */
    function GuardUnavailable() {
      return React.createElement('div', { style: { padding: '16px', lineHeight: 1.7 } },
        React.createElement('p', null, '版本守卫的接口没有挂载成功，因此这里无法显示恢复界面。'),
        React.createElement('p', { style: { opacity: 0.75 } },
          'DSH 打不开时，请直接运行 dsh-version-guard.cmd（或 dsh-version-guard.ps1）打开离线恢复页。'),
      )
    }

    /**
     * Probe the guard's health route once, then show either the page or the
     * explanation. Without this a failed mount would render a blank iframe.
     */
    function GuardSection() {
      var state = React.useState(false)
      var unavailable = state[0]
      var setUnavailable = state[1]
      React.useEffect(function () {
        var cancelled = false
        fetch(guardUrl('/healthz'), { cache: 'no-store' })
          .then(function (response) { return response.json() })
          .then(function (body) {
            if (!cancelled && !(body && body.ok === true)) setUnavailable(true)
          })
          .catch(function () { if (!cancelled) setUnavailable(true) })
        return function () { cancelled = true }
      }, [])
      return unavailable ? React.createElement(GuardUnavailable) : React.createElement(GuardFrame)
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        var locale = typeof ctx.get === 'function' ? ctx.get('locale') : null

        if (locale && typeof locale.register === 'function') {
          try {
            ctx.effect(function () { return locale.register(NS, MESSAGES) }, 'dsh-version-guard: dictionaries')
          } catch (error) { /* the section still renders with its fallback label */ }
        }

        /** Label lookup: the host's translator when present, else built-in zh. */
        function t(key) {
          if (locale && typeof locale.bind === 'function') {
            try {
              var value = locale.bind(NS)(key)
              if (typeof value === 'string' && value.length > 0) return value
            } catch (error) { /* fall through */ }
          }
          return MESSAGES.zh[key] || key
        }

        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'version-guard',
            order: 60,
            label: function () { return t('nav') },
            locale: NS,
          }, GuardSection)
        })
      },
    }
  },
})
