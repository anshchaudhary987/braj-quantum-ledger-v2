/**
 * Returns the financial year (starting year) for a given date.
 * Indian Financial Year: April 1st to March 31st.
 * 
 * Example:
 * - 2025-03-31 => 2024
 * - 2025-04-01 => 2025
 */
export function getFinancialYear(date: string | Date = new Date()): number {
  const d = typeof date === "string" ? new Date(date) : date;
  // getMonth() is 0-indexed (0=Jan, 1=Feb, 2=Mar, 3=Apr)
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}
