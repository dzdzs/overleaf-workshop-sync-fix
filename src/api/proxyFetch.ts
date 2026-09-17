import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';

// Keep proxy handling scoped to the extension. EnvHttpProxyAgent honors the
// standard HTTP_PROXY, HTTPS_PROXY, and NO_PROXY environment variables.
const dispatcher = new EnvHttpProxyAgent();

export const fetch: typeof undiciFetch = ((input: Parameters<typeof undiciFetch>[0], init: any = {}) => {
    return undiciFetch(input, {
        ...init,
        dispatcher: init.dispatcher ?? dispatcher,
    });
}) as typeof undiciFetch;
