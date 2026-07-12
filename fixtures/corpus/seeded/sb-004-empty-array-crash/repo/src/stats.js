export function average(numbers) {
  const total = numbers.reduce((sum, value) => sum + value, 0);
  return total / numbers.length;
}

export function maxValue(numbers) {
  return numbers.reduce((max, value) => (value > max ? value : max), numbers[0]);
}
