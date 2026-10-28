import { NextResponse, type NextRequest, type NextFetchEvent } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
  '/uploads/(.*)'
]);

// Desktop sync calls these server-to-server with `Authorization: Bearer sxd_…`; the routes authenticate the
// device token themselves through getServerAuth(). Minting/revoking tokens (/api/device/tokens) always needs Clerk.
// Device routes must pass `auth.isDevice` as `personalOnly` to userHasProjectAccess.
const DEVICE_ROUTES = /^\/api\/(graph|upload|device\/projects(\/[^/]+)?)$/;
function isDeviceTokenRequest(request: NextRequest): boolean {
  if (!request.headers.get('authorization')?.startsWith('Bearer sxd_')) return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(request.nextUrl.pathname);
  } catch {
    return false;
  }
  return DEVICE_ROUTES.test(pathname) && !pathname.includes('..');
}

// Live collaboration connects the browser to the sync server over WebSocket; allow only that origin.
const collabOrigin = (() => {
  try {
    const url = new URL(process.env.COLLAB_SERVER_URL || '');
    return /^wss?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
})();

// Vercel's preview toolbar (comments, feedback) loads from vercel.live; allow it on preview deployments only.
const vercelToolbar = process.env.VERCEL_ENV === 'preview';

const clerkHandler = clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request) && !isDeviceTokenRequest(request)) {
    await auth.protect();
  }
}, {
  // Clerk merges these with the directives it needs (its own domains, Stripe, Turnstile).
  // ponytail: script-src still allows 'unsafe-inline' because pages are statically rendered;
  // switch to `strict: true` (nonces) once the app pages render dynamically.
  contentSecurityPolicy: {
    directives: {
      'img-src': ['self', 'https:', 'data:', 'blob:'],  // brand art, OG images, favicons, pasted/inline uploads
      'connect-src': [
        ...(collabOrigin ? [collabOrigin] : []),
        ...(vercelToolbar ? ['https://vercel.live', 'wss://ws-us3.pusher.com'] : [])
      ],
      'script-src': vercelToolbar ? ['https://vercel.live'] : [],
      'media-src': ['self', 'https:', 'data:', 'blob:'],
      'frame-src': ['data:', 'blob:', 'https://storage.googleapis.com', ...(vercelToolbar ? ['https://vercel.live'] : [])], // PDF preview
      'style-src': ['https://fonts.googleapis.com', ...(vercelToolbar ? ['https://vercel.live'] : [])],
      'font-src': ['self', 'https://fonts.gstatic.com', 'data:', ...(vercelToolbar ? ['https://vercel.live', 'https://assets.vercel.com'] : [])],
      'object-src': ['none'],
      'base-uri': ['self'],
      'frame-ancestors': ['self']
    }
  }
});

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  // If Clerk is not configured in environment, permit all requests (offline dev mode)
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return NextResponse.next();
  }

  return clerkHandler(req, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)'
  ]
};
