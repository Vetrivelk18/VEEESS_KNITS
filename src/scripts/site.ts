import { updateBadges } from './cart';

updateBadges();
window.addEventListener('storage', updateBadges);

const toggle = document.querySelector<HTMLButtonElement>('[data-menu-toggle]');
const menu = document.getElementById('mobile-menu');
function setMenu(open: boolean) {
  if (!menu || !toggle) return;
  menu.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? 'Close menu' : 'Menu');
}
toggle?.addEventListener('click', () => setMenu(!!menu?.hidden));
// Close after choosing a link (e.g. "Our story" scrolls on the same page), or with Esc.
menu?.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('a')) setMenu(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menu && !menu.hidden) { setMenu(false); toggle?.focus(); }
});
