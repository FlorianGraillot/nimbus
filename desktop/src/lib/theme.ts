export type Theme = 'dark' | 'light';

const THEME_KEY = 'nimbus.theme';
const DENSITY_KEY = 'nimbus.density';

export function getTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
}

export function getDensity(): 'cozy' | 'compact' {
  return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'cozy';
}

export function applyDensity(density: 'cozy' | 'compact'): void {
  document.documentElement.dataset.density = density;
  localStorage.setItem(DENSITY_KEY, density);
}

export function initAppearance(): void {
  applyTheme(getTheme());
  applyDensity(getDensity());
}
