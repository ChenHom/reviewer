export function charge(gateway: { charge(amount: number): void }, amount: string) {
  gateway.charge(Number(amount));
}
