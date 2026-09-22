export function isFriday(date: Date): boolean {
  const day = date.getDay();
  return day === 5;
}
