export function routes(router: any, jwt: any, key: string) {
  router.post('/admin/refunds', (req: any, res: any) => {
    res.json(refundAll());
  });
  router.get('/status', (req: any, res: any) => {
    jwt.verify(req.headers.authorization, key);
    res.json(status());
  });
}
