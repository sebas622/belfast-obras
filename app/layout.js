export const metadata = { title: 'Belfast Obras', description: 'Belfast Obras Particulares' }
export default function Layout({ children }) {
  return (
    <html lang="es">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <meta name="theme-color" content="#0F172A" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <link rel="manifest" href="/manifest.json" />
        <script dangerouslySetInnerHTML={{ __html: `
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').then(reg => {
              reg.addEventListener('updatefound', () => {
                reg.installing?.addEventListener('statechange', e => {
                  if (e.target.state === 'installed' && navigator.serviceWorker.controller) {
                    window.location.reload();
                  }
                });
              });
            }).catch(err => console.error('[sw] no se pudo registrar el service worker:', err));
          }
        `}} />
      </head>
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#F8FAFC' }}>
        {children}
      </body>
    </html>
  )
}
