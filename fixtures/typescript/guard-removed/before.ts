export function approveRefund(user: { isAdmin: boolean }, refund: { approve(): void }) {
  if (!user.isAdmin) {
    throw new Error('forbidden');
  }
  refund.approve();
}
