function (config) {
  if (window.top !== window || location.origin !== config.origin) return;
  const state = window.__suiHubPreferences ??= {};
  state.config = config;
  const apply = () => {
    const current = state.config;
    if (location.origin !== current.origin) return false;
    const locale = current.language === 'zh-CN' ? 'zhHans' : 'en';
    localStorage.setItem('locale', locale);
    localStorage.setItem('theme', current.theme);
    document.documentElement.lang = current.language;
    const app = document.querySelector('#app')?.__vue_app__;
    if (!app) return false;
    const globals = app.config?.globalProperties;
    if (globals?.$i18n) globals.$i18n.locale = locale;
    const provides = app._context?.provides ?? {};
    const themeKey = Reflect.ownKeys(provides).find(key => String(key) === 'Symbol(vuetify:theme)');
    const theme = provides[themeKey];
    const resolved = current.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : current.theme;
    if (typeof theme?.change === 'function') theme.change(current.theme);
    else if (theme?.global?.name) theme.global.name.value = resolved;
    const localeKey = Reflect.ownKeys(provides).find(key => String(key) === 'Symbol(vuetify:locale)');
    if (provides[localeKey]?.current) provides[localeKey].current.value = current.language === 'zh-CN' ? 'zhHans' : 'en';
    return !!globals?.$i18n && !!theme;
  };
  state.apply = apply;
  if (state.timer) clearInterval(state.timer);
  if (!apply()) {
    let attempts = 0;
    state.timer = setInterval(() => {
      if (apply() || ++attempts >= 80) { clearInterval(state.timer); state.timer = null; }
    }, 250);
  }
  if (!state.mediaListener) {
    state.mediaListener = () => { if (state.config.theme === 'system') state.apply(); };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', state.mediaListener);
  }
}
