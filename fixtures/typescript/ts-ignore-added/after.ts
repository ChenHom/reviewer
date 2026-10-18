export function charge(gateway: { charge(amount: number): void }, amount: string) {
  // @ts-ignore
  gateway.charge(amount);
}
