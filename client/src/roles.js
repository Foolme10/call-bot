// "Admin-level" = admin OR vendor: both see everything and manage wallets.
// Only vendor can additionally top up the pool.
export const isAdminLevel = (role) => role === 'admin' || role === 'vendor';
export const isVendor = (role) => role === 'vendor';
