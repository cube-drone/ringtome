// What a person needs to connect an AI assistant to this node (plans/MCP.md, Slice 6): the address
// of its `/mcp`, the one line Claude Code takes, and whether the address is only good on this
// computer - which decides whether a web assistant (claude.ai, ChatGPT) can reach it at all, since
// those connect from their own servers.

/// The name an assistant's own list shows for this node's tools.
export const ASSISTANT_SERVER_NAME = 'horse-drawing-tycoon';

/// Is this an address only this computer can reach? `localhost`, a loopback IP, or nothing at all.
export const onlyThisComputer = (url) => {
    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        return true;
    }
    return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '[::1]' ||
        host === '::1' ||
        /^127\./.test(host)
    );
};

/// Everything the settings page shows, from the node's base URL (its public address, or this page's
/// origin): the `/mcp` address, Claude Code's command for it, and whether it is local only.
export const assistantSetup = (base) => {
    const address = `${String(base || '').replace(/\/+$/, '')}/mcp`;
    return {
        address,
        claudeCode: `claude mcp add --transport http ${ASSISTANT_SERVER_NAME} ${address}`,
        local: onlyThisComputer(address),
    };
};
