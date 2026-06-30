
export default async function sha256(message) {
    // Encode message as UTF-8
    const msgBuffer = new TextEncoder().encode(message);

    // Hash the message
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);

    // Convert ArrayBuffer to byte array
    const hashArray = Array.from(new Uint8Array(hashBuffer));

    // Convert bytes to hex string
    const hashHex = hashArray
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    return hashHex;
}