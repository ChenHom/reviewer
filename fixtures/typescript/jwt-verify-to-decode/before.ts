import jwt from 'jsonwebtoken';

export function currentUser(token: string, secret: string) {
  const payload = jwt.verify(token, secret) as { sub: string };
  return payload.sub;
}
