const { getProxyForUrl } = require('proxy-from-env');
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

// The legacy Socket.IO client uses Node HTTP and ws rather than undici.
// Reuse one proxy agent per protocol and proxy URL.
const agents = new Map<string, any>();

export function forUrl(url: string) {
    const target = String(url).replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    const proxy = getProxyForUrl(target);
    if (!proxy) { return undefined; }

    const secure = new URL(target).protocol==='https:';
    const key = `${secure}:${proxy}`;
    if (!agents.has(key)) {
        agents.set(key, secure ? new HttpsProxyAgent(proxy) : new HttpProxyAgent(proxy));
    }
    return agents.get(key);
}
