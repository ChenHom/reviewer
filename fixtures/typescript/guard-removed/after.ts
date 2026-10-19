export function approveRefund(user: { isAdmin: boolean }, refund: { approve(): void }) {
  refund.approve();
}
