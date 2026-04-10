export function sanitizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_');
}
