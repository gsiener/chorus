/**
 * User mapping module for Linear-Slack integration
 *
 * Maps users between Linear and Slack using email as the common identifier.
 */

export interface User {
  email: string;
  name: string;
  linearId: string;
  slackId: string;
}

/**
 * Array of known users with their Linear and Slack identifiers.
 * Add new users here as they are onboarded.
 */
export const USERS: User[] = [
  {
    email: "test@honeycomb.io",
    name: "Test User",
    linearId: "test-linear-id",
    slackId: "U_TEST_USER",
  },
];

/**
 * Find a user by their email address.
 * @param email - The email address to search for (case-sensitive)
 * @returns The User object if found, undefined otherwise
 */
export function findUserByEmail(email: string): User | undefined {
  return USERS.find((user) => user.email === email);
}

/**
 * Find a user by their Linear ID.
 * @param id - The Linear user ID to search for
 * @returns The User object if found, undefined otherwise
 */
export function findUserByLinearId(id: string): User | undefined {
  return USERS.find((user) => user.linearId === id);
}
