/**
 * Utility functions for Chorus
 */

/**
 * Generate a URL-safe ID from a name
 */
export function nameToId(name: string): string {
  // Define MAX_NAME_LENGTH here, or import if it becomes a shared constant
  const MAX_NAME_LENGTH = 100; // This was originally from initiatives.ts, assuming it's consistent

  return name
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}