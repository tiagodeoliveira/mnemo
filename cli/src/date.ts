// Format a Date as YYYY-MM-DD using the local system timezone. The
// getFullYear/getMonth/getDate methods reflect the runtime's local tz, which
// is inferred from the OS / env (TZ) without explicit configuration.
export function localDate(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
