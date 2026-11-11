import Link from 'next/link';
import { isClerkConfigured } from '@/lib/auth';
import { ConnectDesktop } from './ConnectDesktop';

export const metadata = { title: 'Connect your desktop · Synthex' };

export default async function DesktopConnectPage() {
  if (isClerkConfigured()) {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId, redirectToSignIn } = await auth();
    if (!userId) return redirectToSignIn({ returnBackUrl: '/desktop/connect' });
  }

  return (
    <main className="auth-main">
      <div className="auth-sheet">
        <div className="auth-local">
          {isClerkConfigured() ? <ConnectDesktop /> : (
            <>
              <h2>Desktop connect needs the cloud app</h2>
              <p>This server runs in local mode with no accounts, so there is nothing to sync with. Open the connect page on the Synthex cloud app instead.</p>
              <Link href="/app" className="ink-button">Open your maps</Link>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
