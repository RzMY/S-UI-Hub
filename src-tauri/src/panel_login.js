function (config) {
  if (window.top !== window || location.origin !== config.origin || location.pathname.replace(/\/$/, '') !== config.path) return;
  if (window.__suiHubLoginRunning) return;
  window.__suiHubLoginRunning = true;
  let ticks = 0;
  const timer = setInterval(() => {
    if (++ticks > 80 || location.origin !== config.origin || location.pathname.replace(/\/$/, '') !== config.path) {
      clearInterval(timer); config.password = ''; window.__suiHubLoginRunning = false; return;
    }
    const password = document.querySelector('input[type="password"]');
    const form = password?.closest('form');
    const username = form?.querySelector('input[autocomplete="username"], input[name="username"], input[name="user"], input[type="text"], input:not([type])');
    const submit = form?.querySelector('button[type="submit"], input[type="submit"]');
    if (!password || !username || !submit || submit.disabled) return;
    clearInterval(timer);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setValue.call(username, config.username);
    username.dispatchEvent(new Event('input', { bubbles: true }));
    username.dispatchEvent(new Event('change', { bubbles: true }));
    setValue.call(password, config.password);
    password.dispatchEvent(new Event('input', { bubbles: true }));
    password.dispatchEvent(new Event('change', { bubbles: true }));
    config.password = '';
    // Let Vue/React process model updates before the single form submission.
    setTimeout(() => { submit.click(); window.__suiHubLoginRunning = false; }, 100);
  }, 250);
}
