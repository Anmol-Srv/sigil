/**
 * Central toast feedback — the only channel for transient status/errors.
 * Design-system styled: a sharp surface-1 panel with a hairline border, a 7px
 * status square (red/green/amber/brand) and an optional mono error code.
 * Everything auto-dismisses — errors linger longer because they carry more to
 * read, but a toast nobody closes should not become permanent furniture. Pass
 * `timeout: 0` for the rare case that must stay until code dismisses it (an
 * in-flight "saving…" that its own callback clears). Replaces every inline
 * `out.textContent = …` / `alert()` in the old GUI.
 */
function host() {
  return document.getElementById('toasts');
}

export function toast({ variant = 'info', message = '', hint, code, timeout } = {}) {
  const stack = host();
  if (!stack) return () => {};

  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  el.setAttribute('role', variant === 'error' ? 'alert' : 'status');

  const sq = document.createElement('span');
  sq.className = 'toast-sq';

  const body = document.createElement('div');
  body.className = 'toast-body';

  const msg = document.createElement('div');
  msg.className = 'toast-msg';
  msg.textContent = message;
  body.appendChild(msg);

  if (hint) {
    const h = document.createElement('div');
    h.className = 'toast-hint';
    h.textContent = hint;
    body.appendChild(h);
  }
  if (code) {
    const c = document.createElement('span');
    c.className = 'toast-code';
    c.textContent = code;
    body.appendChild(c);
  }

  const x = document.createElement('button');
  x.className = 'toast-x';
  x.type = 'button';
  x.textContent = '×';
  x.setAttribute('aria-label', 'dismiss');
  const remove = () => { el.remove(); };
  x.onclick = remove;

  el.append(sq, body, x);
  stack.appendChild(el);

  const ttl = timeout != null ? timeout : (variant === 'error' ? 9000 : 4000);
  if (ttl > 0) setTimeout(remove, ttl);
  return remove;
}

export const toastError = (o) => toast({ ...o, variant: 'error' });
export const toastOk = (o) => toast({ ...o, variant: 'success' });
export const toastInfo = (o) => toast({ ...o, variant: 'info' });
