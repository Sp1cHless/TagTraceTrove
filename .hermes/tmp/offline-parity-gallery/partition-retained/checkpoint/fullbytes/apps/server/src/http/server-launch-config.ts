export interface ServerBinding {
  hostname: string;
  enableLan: boolean;
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function resolveServerBinding(
  environment: Readonly<Record<string, string | undefined>>,
): ServerBinding {
  const hostname = environment.T3_HOST ?? '127.0.0.1';
  const enableLan = environment.T3_ENABLE_LAN === 'true';
  if (!loopbackHosts.has(hostname) && !enableLan) {
    throw new Error('Set T3_ENABLE_LAN=true before binding the API outside localhost');
  }
  return { hostname, enableLan };
}
