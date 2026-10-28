import { Footer } from './components/Footer.tsx';
import { Nav } from './components/Nav.tsx';
import { HomePage } from './pages/Home.tsx';
import { PrivacyPage } from './pages/Privacy.tsx';
import { routeFor } from './routes.ts';

export function App({ path }: { path: string }) {
  const route = routeFor(path);
  return (
    <div className="flex min-h-full flex-col bg-canvas text-base leading-normal text-ink">
      <Nav />
      <main className="flex-1" id="main">
        {route === '/privacy' ? <PrivacyPage /> : <HomePage />}
      </main>
      <Footer />
    </div>
  );
}
