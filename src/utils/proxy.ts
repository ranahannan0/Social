/**
 * TRUST_PROXY_HOPS Configuration & Validation
 *
 * Requirements:
 * - Default to 0 (no trusted proxy: client IP resolved from socket directly).
 * - Never use 'trust proxy = true' globally (which would trust arbitrary client-supplied headers).
 * - Do not hardcode 1 without verifying deployment topology.
 * - Accept an environment-controlled numeric hop count (TRUST_PROXY_HOPS).
 * - Prevent spoofed X-Forwarded-For headers from bypassing IP-based rate limiting.
 *
 * Topology Reference:
 * - 0 hops (default): Directly exposed Node.js or local dev. No reverse proxy trusted.
 * - 1 hop: Single reverse proxy (e.g., standard Google Cloud Run, AWS ALB, Nginx).
 * - 2 hops: Two reverse proxies (e.g., Cloudflare CDN -> Cloud Run -> Node.js).
 * - N hops: N chained reverse proxies.
 */

export function resolveTrustProxyHops(rawEnvValue?: string): number {
  if (!rawEnvValue) return 0;
  const trimmed = rawEnvValue.trim();

  // Strictly disallow boolean 'true' to prevent global arbitrary header trust
  if (trimmed.toLowerCase() === 'true') {
    console.warn(
      '[Security Warning] TRUST_PROXY_HOPS cannot be set to boolean true. Global proxy trust is disabled for security. Defaulting to 0 hops.'
    );
    return 0;
  }

  // Only accept positive integer values representing exact hop counts
  if (/^\d+$/.test(trimmed)) {
    const parsed = parseInt(trimmed, 10);
    return parsed > 0 ? parsed : 0;
  }

  return 0;
}
