export function isMonday(date: Date): boolean {
  const day = date.getDay();
  return day === 1;
}
