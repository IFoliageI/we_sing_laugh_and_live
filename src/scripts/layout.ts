type ThemeMode = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'lmy-theme-mode';
const EG_UNLOCK_KEY = 'lmy-easter-unlock';
const MODE_ICON: Record<ThemeMode, string> = {
  light: String.fromCharCode(0xE706),
  dark: String.fromCharCode(0xEC46),
  system: String.fromCharCode(0xE770),
};

function isThemeMode(value: string | undefined | null): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function initializeLayout() {
  const toggle = document.getElementById('theme-toggle');
  const menu = document.getElementById('theme-menu');
  const drawer = document.getElementById('drawer');
  const overlay = document.getElementById('drawer-overlay');
  const openButton = document.getElementById('drawer-open');
  const closeButton = document.getElementById('drawer-close');
  if (!toggle || !menu || !drawer || !overlay || !openButton || !closeButton) return;

  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-mode]'));
  const background = Array.from(document.querySelectorAll<HTMLElement>('.app-header, .app-main, .app-footer'));
  const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  let mode: ThemeMode = 'system';
  let taps = 0;
  let returnFocus: HTMLElement | null = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isThemeMode(saved)) mode = saved;
  } catch {
    // 隐私设置禁用存储时，主题和导航仍然可用。
  }

  function renderTheme() {
    document.documentElement.classList.toggle('dark', mode === 'dark' || (mode === 'system' && darkMedia.matches));
    toggle!.textContent = MODE_ICON[mode];
    items.forEach((item) => {
      const active = item.dataset.mode === mode;
      item.classList.toggle('active', active);
      item.setAttribute('aria-checked', String(active));
      const check = item.querySelector('[data-check]');
      if (check) check.textContent = active ? String.fromCharCode(0xE73E) : '';
    });
  }

  function setMenu(open: boolean, focus = false) {
    menu!.inert = !open;
    menu!.classList.toggle('open', open);
    toggle!.setAttribute('aria-expanded', String(open));
    if (focus) {
      if (open) (items.find((item) => item.dataset.mode === mode) ?? items[0])?.focus();
      else toggle!.focus();
    }
  }

  function setDrawer(open: boolean) {
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : openButton;
      setMenu(false);
    }
    drawer!.inert = !open;
    drawer!.classList.toggle('open', open);
    overlay!.classList.toggle('open', open);
    drawer!.setAttribute('aria-hidden', String(!open));
    openButton!.setAttribute('aria-expanded', String(open));
    background.forEach((element) => { element.inert = open; });
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) closeButton!.focus();
    else returnFocus?.focus();
  }

  renderTheme();
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenu(!menu.classList.contains('open'));
    if (++taps >= 15) {
      try { sessionStorage.setItem(EG_UNLOCK_KEY, '1'); } catch {}
      taps = 0;
    }
  });
  toggle.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setMenu(true, true);
    }
  });
  items.forEach((item) => {
    item.addEventListener('click', () => {
      if (!isThemeMode(item.dataset.mode)) return;
      mode = item.dataset.mode;
      try { localStorage.setItem(STORAGE_KEY, mode); } catch {}
      renderTheme();
      setMenu(false, true);
      taps = 0;
    });
  });
  menu.addEventListener('keydown', (event) => {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % items.length; break;
      case 'ArrowUp': next = (index + items.length - 1) % items.length; break;
      case 'Home': next = 0; break;
      case 'End': next = items.length - 1; break;
      default: return;
    }
    event.preventDefault();
    items[next]?.focus();
  });
  document.addEventListener('click', (event) => {
    if (event.target instanceof Node && !menu.contains(event.target)) setMenu(false);
  });
  document.addEventListener('focusin', (event) => {
    if (event.target instanceof Node && !menu.contains(event.target) && event.target !== toggle) setMenu(false);
  });
  darkMedia.addEventListener('change', () => {
    if (mode === 'system') renderTheme();
  });

  openButton.addEventListener('click', () => setDrawer(true));
  closeButton.addEventListener('click', () => setDrawer(false));
  overlay.addEventListener('click', () => setDrawer(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (drawer.classList.contains('open')) setDrawer(false);
      if (menu.classList.contains('open')) setMenu(false, true);
    }
    if (event.key !== 'Tab' || !drawer.classList.contains('open')) return;
    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
}

initializeLayout();
