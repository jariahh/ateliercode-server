import * as jose from 'jose';
import { config } from './config.js';

interface KeycloakTokenPayload {
  sub: string;
  email?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  realm_access?: {
    roles: string[];
  };
  resource_access?: Record<string, { roles: string[] }>;
}

export interface VerifiedUser {
  id: string;       // Keycloak sub claim
  email: string;
  username: string;
  roles: string[];
}

let jwks: jose.JWTVerifyGetKey | null = null;

function getJWKS(): jose.JWTVerifyGetKey {
  if (!jwks) {
    jwks = jose.createRemoteJWKSet(new URL(config.keycloak.jwksUrl));
  }
  return jwks;
}

/**
 * Verify a Keycloak access token using JWKS.
 * Returns the verified user info or null if invalid.
 */
export async function verifyToken(token: string): Promise<VerifiedUser | null> {
  try {
    const { payload } = await jose.jwtVerify(token, getJWKS(), {
      issuer: config.keycloak.issuer,
    });

    const claims = payload as unknown as KeycloakTokenPayload;

    if (!claims.sub) {
      return null;
    }

    const roles = claims.realm_access?.roles ?? [];

    return {
      id: claims.sub,
      email: claims.email ?? '',
      username: claims.preferred_username ?? claims.email ?? claims.sub,
      roles,
    };
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}
