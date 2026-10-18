import jwt from 'jsonwebtoken';

export function currentUser(token: string, secret: string) {
  const payload = jwt.decode(token) as { sub: string };
  return payload.sub;
}
