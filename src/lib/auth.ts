/**
 * Synthex Studio: Unified Authentication & Multi-Tenant Authorization Provider
 * Integrates Clerk for production SaaS and provides zero-config offline fallback.
 */

import { getUserByClerkId, getUserById, getUserIdForDeviceToken, projectExistsInDb, upsertUser, type UserRecord } from './db.ts';

export interface AuthContext {
  userId: string;
  clerkId: string | null;
  orgId: string | null;
  orgRole: string | null;
  isLocal: boolean;
  /** Authenticated by a desktop device token: personal maps only, and never allowed to mint or revoke tokens. */
  isDevice?: boolean;
  user: UserRecord | null;
}

const SIGNED_OUT: AuthContext = { userId: '', clerkId: null, orgId: null, orgRole: null, isLocal: false, user: null };

export function isClerkConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
    process.env.CLERK_SECRET_KEY
  );
}

/**
 * Retrieves the current authentication and organization context on the server.
 * In production, extracts verified Clerk session claims.
 * In local/offline mode, provides a fallback development researcher context.
 */
export async function getServerAuth(): Promise<AuthContext> {
  if (!isClerkConfigured()) {
    // Zero-config offline/local development mode
    let localUser = (await getUserByClerkId('local_researcher')) as UserRecord | null;
    if (!localUser) {
      localUser = (await upsertUser({
        clerkId: 'local_researcher',
        email: 'local@synthex.internal',
        name: 'Local Researcher',
        subscriptionTier: 'pro',
        subscriptionStatus: 'active',
        contextCredits: 5000,
        trialEndsAt: null
      })) as UserRecord;
    }

    return {
      userId: localUser.id,
      clerkId: 'local_researcher',
      orgId: null,
      orgRole: null,
      isLocal: true,
      user: localUser
    };
  }

  // A desktop device token never falls through to Clerk: unknown or revoked means signed out.
  const { headers } = await import('next/headers');
  const authorization = (await headers()).get('authorization') || '';
  if (authorization.startsWith('Bearer sxd_')) {
    const ownerId = await getUserIdForDeviceToken(authorization.slice('Bearer '.length).trim());
    const owner = ownerId ? ((await getUserById(ownerId)) as UserRecord | null) : null;
    if (!owner) return { ...SIGNED_OUT };
    return { userId: owner.id, clerkId: owner.clerkId, orgId: null, orgRole: null, isLocal: false, isDevice: true, user: owner };
  }

  // Only a Clerk failure means "signed out". Database errors below must propagate so routes
  // answer 500 and log the cause, instead of turning a signed-in user's request into a 401.
  let authState: { userId: string | null; orgId?: string | null; orgRole?: string | null };
  try {
    const { auth } = await import('@clerk/nextjs/server');
    authState = await auth();
  } catch (error) {
    console.warn('Failed to resolve Clerk authentication context:', error);
    authState = { userId: null };
  }

  if (!authState.userId) return { ...SIGNED_OUT };

  let userRecord = (await getUserByClerkId(authState.userId)) as UserRecord | null;
  if (!userRecord) {
    // First-time sign in: requires mandatory subscription plan selection
    userRecord = (await upsertUser({
      clerkId: authState.userId,
      subscriptionTier: 'none',
      subscriptionStatus: 'unselected',
      contextCredits: 0,
      trialEndsAt: null
    })) as UserRecord;
  }

  return {
    userId: userRecord.id,
    clerkId: authState.userId,
    orgId: authState.orgId || null,
    orgRole: authState.orgRole || null,
    isLocal: false,
    user: userRecord
  };
}


/** Device callers learn why a map is out of reach: 403 it exists but isn't theirs (or is a team map), 410 no such map. */
export async function deviceProjectDenied(projectId: string): Promise<Response> {
  return (await projectExistsInDb(projectId))
    ? Response.json({ error: 'This map is not available to this desktop.' }, { status: 403 })
    : Response.json({ error: 'This map no longer exists.' }, { status: 410 });
}
