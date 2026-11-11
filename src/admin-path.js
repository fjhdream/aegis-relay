// The files the admin page is made of besides the page itself (web/), each with its content type.
// One list: the admin server hands these out, and a panel served at the root of its domain tells
// them apart from node paths by it.
export const UI_FILES = {
  '/app.js': 'text/javascript; charset=utf-8',
  '/view.js': 'text/javascript; charset=utf-8',
  '/style.css': 'text/css; charset=utf-8',
  '/help.css': 'text/css; charset=utf-8'
};
const ROOT_STATIC_PATHS = new Set(['/', '/index.html', ...Object.keys(UI_FILES)]);

export function normalizeAdminPath(value) {
  const clean = String(value ?? '_aegis').replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}` : '/';
}

export function adminRelative(pathname, prefix) {
  if (prefix === '/') return pathname || '/';
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length) || '/';
}

export function isRootAdminRequest(pathname) {
  return ROOT_STATIC_PATHS.has(pathname) || pathname.startsWith('/api/');
}
