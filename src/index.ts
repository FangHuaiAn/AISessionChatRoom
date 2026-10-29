export { Directory } from './directory';
export { Room } from './room';
export default {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/chat/v1/health') return Response.json({status: 'ok'});
    return Response.json({error: {code: 'not_found'}}, {status: 404});
  },
} satisfies ExportedHandler<Env>;
